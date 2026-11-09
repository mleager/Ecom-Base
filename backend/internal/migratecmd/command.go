// Package migratecmd applies the embedded schema migrations. It is the one
// path that changes a deployed schema: a one-off job, run with the migrator
// credentials before the API starts. It only moves forward.
package migratecmd

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
	"time"

	"ecom/backend"
	"ecom/backend/internal/platform/config"
	"ecom/backend/internal/platform/database"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

const (
	// VersionTable is the goose table that the API's readiness check reads.
	VersionTable = "public.goose_db_version"

	// A waiting run polls the advisory lock every second for up to ten
	// minutes, then gives up without applying anything.
	lockPollSeconds = 1
	lockAttempts    = 600
	runTimeout      = 15 * time.Minute
)

const usage = `Usage: migrate <up|status>

  up      apply every pending embedded migration under a PostgreSQL advisory lock
  status  list applied and pending migrations in a read-only transaction

Environment: APP_ENV (local or production) and DATABASE_URL (migrator
credentials). Output is JSON lines on standard output. The database URL is
never printed.
`

// Migration is one line of output: "applied" or "failed" during up, and
// "migration" during status. State is applied, pending or unknown (applied
// in the database but newer than this build).
type Migration struct {
	Event      string     `json:"event"`
	Version    int64      `json:"version"`
	Source     string     `json:"source,omitempty"`
	State      string     `json:"state,omitempty"`
	AppliedAt  *time.Time `json:"applied_at,omitempty"`
	DurationMS *int64     `json:"duration_ms,omitempty"`
	Error      string     `json:"error,omitempty"`
}

// Summary is the last line of every successful connection. Version is the
// schema version afterwards, as readiness computes it; Ready reports whether
// this build's API would accept it.
type Summary struct {
	Event   string `json:"event"`
	Command string `json:"command"`
	Version int64  `json:"version"`
	Latest  int64  `json:"latest"`
	Minimum int64  `json:"minimum"`
	Applied int    `json:"applied"`
	Pending int    `json:"pending"`
	Ready   bool   `json:"ready"`
}

// Parse accepts exactly one command. Help goes to help and returns flag.ErrHelp.
func Parse(args []string, help io.Writer) (string, error) {
	if len(args) == 1 {
		switch args[0] {
		case "up", "status":
			return args[0], nil
		case "-h", "-help", "--help", "help":
			_, _ = io.WriteString(help, usage)
			return "", flag.ErrHelp
		}
	}
	return "", errors.New("expected exactly one command, up or status; use migrate --help")
}

// Run applies or reports the migrations embedded in this build.
func Run(ctx context.Context, args []string, getenv func(string) string, output, help io.Writer) error {
	return RunFS(ctx, backend.Migrations(), args, getenv, output, help)
}

// RunFS is Run with another migration set; tests use it to add migrations.
// It reads only explicit process configuration and never loads .env.
func RunFS(ctx context.Context, fsys fs.FS, args []string, getenv func(string) string, output, help io.Writer) error {
	command, err := Parse(args, help)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}

	connectionURL := getenv("DATABASE_URL")
	if err := config.ValidateDatabase(getenv("APP_ENV"), connectionURL); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()

	db, err := open(connectionURL)
	if err != nil {
		return err
	}
	provider, err := newProvider(db, fsys)
	if err != nil {
		_ = db.Close()
		return err
	}
	// Close also closes db.
	defer func() { _ = provider.Close() }()

	encoder := json.NewEncoder(output)
	if command == "status" {
		return status(ctx, db, provider, encoder)
	}
	return up(ctx, db, provider, encoder)
}

func open(connectionURL string) (*sql.DB, error) {
	c, err := pgx.ParseConfig(connectionURL)
	if err != nil {
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	c.ConnectTimeout = 5 * time.Second
	c.RuntimeParams["timezone"] = "UTC"
	if c.RuntimeParams["application_name"] == "" {
		c.RuntimeParams["application_name"] = "ecom-migrate"
	}
	// A DDL statement queued behind a long transaction blocks every later
	// query on that table. Fail instead; the transaction rolls back and the
	// run can be repeated.
	if c.RuntimeParams["lock_timeout"] == "" {
		c.RuntimeParams["lock_timeout"] = "10000"
	}
	db := stdlib.OpenDB(*c)
	// One session holds the advisory lock and runs migrations; one more
	// reads versions for the summary.
	db.SetMaxOpenConns(2)
	return db, nil
}

func newProvider(db *sql.DB, fsys fs.FS) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockTimeout(lockPollSeconds, lockAttempts))
	if err != nil {
		return nil, errors.New("could not configure the migration lock")
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, fsys,
		goose.WithTableName(VersionTable),
		goose.WithSessionLocker(locker),
		goose.WithDisableGlobalRegistry(true),
	)
	if err != nil {
		return nil, fmt.Errorf("invalid embedded migrations: %v", err)
	}
	return provider, nil
}

func up(ctx context.Context, db *sql.DB, provider *goose.Provider, encoder *json.Encoder) error {
	results, runErr := provider.Up(ctx)
	var partial *goose.PartialError
	if errors.As(runErr, &partial) {
		results = partial.Applied
	}

	for _, result := range results {
		duration := result.Duration.Milliseconds()
		if err := encoder.Encode(Migration{Event: "applied", Version: result.Source.Version, Source: path.Base(result.Source.Path), DurationMS: &duration}); err != nil {
			return errors.New("could not write migration output")
		}
	}
	if partial != nil && partial.Failed != nil {
		failed := Migration{Event: "failed", Version: partial.Failed.Source.Version, Source: path.Base(partial.Failed.Source.Path), Error: describe(partial.Err)}
		if err := encoder.Encode(failed); err != nil {
			return errors.New("could not write migration output")
		}
	}

	applied, readErr := appliedVersions(ctx, db)
	if readErr == nil && (runErr == nil || partial != nil) {
		version := current(applied)
		latest := latestSource(provider)
		if err := encoder.Encode(Summary{Event: "summary", Command: "up", Version: version, Latest: latest, Minimum: database.MinSchemaVersion, Applied: len(results), Pending: len(pending(provider, applied)), Ready: version >= database.MinSchemaVersion}); err != nil {
			return errors.New("could not write migration output")
		}
	}

	switch {
	case partial != nil && partial.Failed != nil && readErr == nil:
		return fmt.Errorf("migration %d failed; schema version is %d", partial.Failed.Source.Version, current(applied))
	case partial != nil && partial.Failed != nil:
		return fmt.Errorf("migration %d failed; run status to read the schema version", partial.Failed.Source.Version)
	case runErr != nil && ctx.Err() != nil:
		return errors.New("migration run interrupted or deadline exceeded; run status before retrying")
	case runErr != nil:
		return fmt.Errorf("migration run failed: %s", describe(runErr))
	case readErr != nil:
		return fmt.Errorf("migrations applied but the version could not be read: %s", describe(readErr))
	}
	return nil
}

func status(ctx context.Context, db *sql.DB, provider *goose.Provider, encoder *json.Encoder) error {
	applied, err := appliedVersions(ctx, db)
	if err != nil {
		if ctx.Err() != nil {
			return errors.New("status interrupted or deadline exceeded")
		}
		return fmt.Errorf("could not read migration status: %s", describe(err))
	}

	known := map[int64]bool{}
	for _, source := range provider.ListSources() {
		known[source.Version] = true
		row := Migration{Event: "migration", Version: source.Version, Source: path.Base(source.Path), State: "pending"}
		if at, ok := applied[source.Version]; ok {
			row.State, row.AppliedAt = "applied", &at
		}
		if err := encoder.Encode(row); err != nil {
			return errors.New("could not write migration output")
		}
	}

	unknown := make([]int64, 0)
	for version := range applied {
		if !known[version] {
			unknown = append(unknown, version)
		}
	}
	sort.Slice(unknown, func(i, j int) bool { return unknown[i] < unknown[j] })
	for _, version := range unknown {
		at := applied[version]
		if err := encoder.Encode(Migration{Event: "migration", Version: version, State: "unknown", AppliedAt: &at}); err != nil {
			return errors.New("could not write migration output")
		}
	}

	version := current(applied)
	if err := encoder.Encode(Summary{Event: "summary", Command: "status", Version: version, Latest: latestSource(provider), Minimum: database.MinSchemaVersion, Pending: len(pending(provider, applied)), Ready: version >= database.MinSchemaVersion}); err != nil {
		return errors.New("could not write migration output")
	}
	return nil
}

// appliedVersions reads the versions whose latest goose row is applied, in a
// read-only transaction that never creates the version table.
func appliedVersions(ctx context.Context, db *sql.DB) (map[int64]time.Time, error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT to_regclass($1) IS NOT NULL`, VersionTable).Scan(&exists); err != nil {
		return nil, err
	}
	applied := map[int64]time.Time{}
	if !exists {
		return applied, nil
	}

	// Same rule as database.Ready: a version counts when its newest row is applied.
	rows, err := tx.QueryContext(ctx, `SELECT version_id, tstamp FROM (
SELECT DISTINCT ON (version_id) version_id, is_applied, tstamp
FROM `+VersionTable+` ORDER BY version_id, id DESC
) AS latest WHERE is_applied AND version_id > 0`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var version int64
		var at time.Time
		if err := rows.Scan(&version, &at); err != nil {
			return nil, err
		}
		applied[version] = at.UTC()
	}
	return applied, rows.Err()
}

func current(applied map[int64]time.Time) int64 {
	var version int64
	for v := range applied {
		version = max(version, v)
	}
	return version
}

func latestSource(provider *goose.Provider) int64 {
	var version int64
	for _, source := range provider.ListSources() {
		version = max(version, source.Version)
	}
	return version
}

func pending(provider *goose.Provider, applied map[int64]time.Time) []int64 {
	var result []int64
	for _, source := range provider.ListSources() {
		if _, ok := applied[source.Version]; !ok {
			result = append(result, source.Version)
		}
	}
	return result
}

// describe keeps operator-useful detail without connection settings:
// PostgreSQL errors keep their SQLSTATE and message, and connection errors
// (which name the user, host and database) become a fixed message. Other
// errors come from goose or database/sql and carry no connection settings.
func describe(err error) string {
	var connectErr *pgconn.ConnectError
	var pgErr *pgconn.PgError
	switch {
	case errors.As(err, &connectErr):
		return "could not connect to PostgreSQL"
	case errors.As(err, &pgErr):
		return fmt.Sprintf("SQLSTATE %s: %s", pgErr.Code, pgErr.Message)
	case strings.Contains(err.Error(), "failed to acquire lock"):
		return "timed out waiting for the migration lock held by another run"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "interrupted or deadline exceeded"
	}
	return err.Error()
}
