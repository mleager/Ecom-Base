// Package dbbootstrapcmd creates the application's PostgreSQL roles and hands
// the database to the schema owner. It is a one-off job run with the
// administrator (on RDS, the master user) credentials, before migrate. It is
// the Go form of infrastructure/postgres/init.sh, adapted for RDS, where the
// master user is rds_superuser and not a superuser: it must be a member of
// ecom_migrator before it can hand the database and schema to it.
//
// Every statement is idempotent and the role passwords are (re)set on every
// run, so it is safe to repeat and after a password change. A session
// advisory lock serialises concurrent runs.
//
// Passwords are sent only as SCRAM-SHA-256 verifiers computed here, never as
// text: PostgreSQL logs a failing statement (log_min_error_statement), and
// on RDS those logs are kept and readable by anyone with log access.
package dbbootstrapcmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	"ecom/backend/internal/platform/config"
	"ecom/backend/internal/platform/database"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	// MigratorRole owns the database, the public schema and every table.
	MigratorRole = "ecom_migrator"
	// AppRole is the runtime role: CONNECT, schema USAGE and the grants
	// that migrations add.
	AppRole = "ecom_app"

	// LockKey is hashed by PostgreSQL into the advisory lock key.
	LockKey = "ecom-db-bootstrap"

	minPasswordLength = 16
	runTimeout        = 5 * time.Minute
)

const usage = `Usage: db-bootstrap

Creates the ecom_migrator and ecom_app roles if they are missing, sets their
passwords, makes ecom_migrator the owner of the database and the public
schema, and limits ecom_app to CONNECT, USAGE and the tables migrations grant.

Environment:
  APP_ENV            local or production
  DB_HOST, DB_PORT   PostgreSQL server (port defaults to 5432)
  DB_NAME            database to hand to ecom_migrator
  DB_USER            administrator (the RDS master user)
  DB_PASSWORD        administrator password
  DB_SSLMODE         defaults to verify-full; disable only for local loopback
  DB_SSLROOTCERT     CA bundle for verify-full
  MIGRATOR_PASSWORD  password to set for ecom_migrator (16 or more printable
                     ASCII characters)
  APP_DB_PASSWORD    password to set for ecom_app (16 or more printable ASCII
                     characters)

ecom_app also gets role defaults for statement_timeout, lock_timeout and
idle_in_transaction_session_timeout. Passwords are sent to PostgreSQL only as
SCRAM-SHA-256 verifiers. Output is one JSON line on standard output.
Passwords are never printed.
`

// Summary is the single line written after a successful run.
type Summary struct {
	Event    string   `json:"event"`
	Command  string   `json:"command"`
	Database string   `json:"database"`
	Created  []string `json:"created"`
	Ready    bool     `json:"ready"`
}

// Settings is the validated configuration.
type Settings struct {
	ConnectionURL    string
	Database         string
	AdminUser        string
	MigratorPassword string
	AppPassword      string
}

// Run bootstraps the roles. It reads only explicit process configuration.
func Run(ctx context.Context, args []string, getenv func(string) string, output, help io.Writer) error {
	if len(args) == 1 {
		switch args[0] {
		case "-h", "-help", "--help", "help":
			_, _ = io.WriteString(help, usage)
			return nil
		}
	}
	if len(args) != 0 {
		return errors.New("db-bootstrap takes no arguments; use db-bootstrap --help")
	}

	settings, err := Load(getenv)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()

	created, err := Bootstrap(ctx, settings)
	if err != nil {
		return err
	}
	summary := Summary{Event: "summary", Command: "db-bootstrap", Database: settings.Database, Created: created, Ready: true}
	if err := json.NewEncoder(output).Encode(summary); err != nil {
		return errors.New("could not write bootstrap output")
	}
	return nil
}

// Load builds the administrator URL from separate settings, because ECS can
// inject a secret value but cannot compose one into a URL, and validates it
// with the same rules as every other database connection.
func Load(getenv func(string) string) (Settings, error) {
	host, name, user := getenv("DB_HOST"), getenv("DB_NAME"), getenv("DB_USER")
	password := getenv("DB_PASSWORD")
	if host == "" || name == "" || user == "" || password == "" {
		return Settings{}, errors.New("DB_HOST, DB_NAME, DB_USER and DB_PASSWORD are required")
	}
	port := getenv("DB_PORT")
	if port == "" {
		port = "5432"
	}
	mode := getenv("DB_SSLMODE")
	if mode == "" {
		mode = "verify-full"
	}

	query := url.Values{"sslmode": {mode}}
	if root := getenv("DB_SSLROOTCERT"); root != "" {
		query.Set("sslrootcert", root)
	}
	connection := url.URL{
		Scheme:   "postgresql",
		User:     url.UserPassword(user, password),
		Host:     host + ":" + port,
		Path:     "/" + name,
		RawQuery: query.Encode(),
	}
	if err := config.ValidateDatabase(getenv("APP_ENV"), connection.String()); err != nil {
		// The validator's messages name settings, never values.
		return Settings{}, errors.New(strings.ReplaceAll(err.Error(), "DATABASE_URL", "the DB_* settings"))
	}

	migrator, app := getenv("MIGRATOR_PASSWORD"), getenv("APP_DB_PASSWORD")
	if len(migrator) < minPasswordLength || len(app) < minPasswordLength {
		return Settings{}, fmt.Errorf("MIGRATOR_PASSWORD and APP_DB_PASSWORD must each have at least %d characters", minPasswordLength)
	}
	if !printableASCII(migrator) || !printableASCII(app) {
		return Settings{}, errors.New("MIGRATOR_PASSWORD and APP_DB_PASSWORD must contain only printable ASCII characters")
	}
	if migrator == app || migrator == password || app == password {
		return Settings{}, errors.New("the administrator, migrator and app passwords must all differ")
	}
	return Settings{ConnectionURL: connection.String(), Database: name, AdminUser: user, MigratorPassword: migrator, AppPassword: app}, nil
}

// Bootstrap applies the role setup and returns the roles it created.
func Bootstrap(ctx context.Context, s Settings) ([]string, error) {
	c, err := pgx.ParseConfig(s.ConnectionURL)
	if err != nil {
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	c.ConnectTimeout = 10 * time.Second
	c.RuntimeParams["application_name"] = "ecom-db-bootstrap"

	conn, err := pgx.ConnectConfig(ctx, c)
	if err != nil {
		return nil, fmt.Errorf("bootstrap failed: %s", describe(err))
	}
	defer func() { _ = conn.Close(context.Background()) }()

	// Session lock: released on unlock or when the connection closes.
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, LockKey); err != nil {
		return nil, fmt.Errorf("could not take the bootstrap lock: %s", describe(err))
	}
	defer func() { _, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext($1))`, LockKey) }()

	created, err := apply(ctx, conn, s)
	if err != nil {
		return nil, fmt.Errorf("bootstrap failed: %s", describe(err))
	}
	return created, nil
}

func apply(ctx context.Context, conn *pgx.Conn, s Settings) ([]string, error) {
	created := []string{}
	for _, role := range []string{MigratorRole, AppRole} {
		var exists bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1)`, role).Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			if _, err := conn.Exec(ctx, "CREATE ROLE "+pgx.Identifier{role}.Sanitize()); err != nil {
				// Another bootstrap outside this lock created it first.
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "42710" {
					return nil, err
				}
			} else {
				created = append(created, role)
			}
		}
	}

	// ALTER ROLE cannot take a bind parameter, and a failing statement is
	// logged with its text, so only a verifier is ever sent.
	for _, role := range []struct{ name, password string }{{MigratorRole, s.MigratorPassword}, {AppRole, s.AppPassword}} {
		statement, err := passwordStatement(role.name, role.password)
		if err != nil {
			return nil, err
		}
		if _, err := conn.Exec(ctx, statement); err != nil {
			return nil, err
		}
	}

	database := pgx.Identifier{s.Database}.Sanitize()
	migrator := pgx.Identifier{MigratorRole}.Sanitize()
	app := pgx.Identifier{AppRole}.Sanitize()
	statements := []string{
		// RDS: the master user needs membership to transfer ownership.
		"GRANT " + migrator + " TO " + pgx.Identifier{s.AdminUser}.Sanitize(),
		"ALTER DATABASE " + database + " OWNER TO " + migrator,
		"REVOKE ALL ON DATABASE " + database + " FROM PUBLIC",
		"GRANT CONNECT ON DATABASE " + database + " TO " + app,
		"ALTER SCHEMA public OWNER TO " + migrator,
		"REVOKE ALL ON SCHEMA public FROM PUBLIC",
		"GRANT USAGE ON SCHEMA public TO " + app,
		"ALTER DEFAULT PRIVILEGES FOR ROLE " + migrator + " IN SCHEMA public GRANT SELECT ON TABLES TO " + app,
	}
	statements = append(statements, roleTimeoutStatements()...)
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			return nil, err
		}
	}
	return created, nil
}

// passwordStatement sets role's password from a new SCRAM-SHA-256 verifier.
// The verifier is base64, '$' and ':' only, so it needs no escaping.
func passwordStatement(role, password string) (string, error) {
	verifier, err := newSCRAMVerifier(password)
	if err != nil {
		return "", err
	}
	return "ALTER ROLE " + pgx.Identifier{role}.Sanitize() + " LOGIN PASSWORD '" + verifier + "'", nil
}

// roleTimeoutStatements gives ecom_app the API pool's session limits as role
// defaults, plus an idle-in-transaction limit, as a server-side backstop.
// Values are milliseconds, the parameters' base unit.
func roleTimeoutStatements() []string {
	app := pgx.Identifier{AppRole}.Sanitize()
	set := func(parameter string, value time.Duration) string {
		return "ALTER ROLE " + app + " SET " + parameter + " = " + strconv.FormatInt(value.Milliseconds(), 10)
	}
	return []string{
		set("statement_timeout", database.StatementTimeout),
		set("lock_timeout", database.LockTimeout),
		set("idle_in_transaction_session_timeout", database.IdleInTransactionTimeout),
	}
}

// describe keeps the SQLSTATE and message of PostgreSQL errors and replaces
// connection errors, which name the user, host and database, with a fixed
// message. No statement text is included, so no password can appear.
func describe(err error) string {
	var connectErr *pgconn.ConnectError
	var pgErr *pgconn.PgError
	switch {
	case errors.As(err, &connectErr):
		return "could not connect to PostgreSQL"
	case errors.As(err, &pgErr):
		return fmt.Sprintf("SQLSTATE %s: %s", pgErr.Code, pgErr.Message)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "interrupted or deadline exceeded"
	}
	return "PostgreSQL request failed"
}
