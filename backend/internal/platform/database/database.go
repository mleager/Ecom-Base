package database

import (
	"context"
	"errors"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MinSchemaVersion is the oldest schema this build runs against. Readiness
// also accepts newer versions, so a migration can land before the API that
// needs it (forward-only, expand then contract).
const MinSchemaVersion int64 = 13

// Pool size defaults, used only when DATABASE_URL does not set pgx's
// pool_max_conns or pool_min_conns.
const (
	DefaultMaxConns int32 = 10
	DefaultMinConns int32 = 0
)

// Open connects without telemetry. See OpenInstrumented.
func Open(ctx context.Context, connectionURL string) (*pgxpool.Pool, error) {
	return OpenInstrumented(ctx, connectionURL, Instrumentation{})
}

// OpenInstrumented connects with query spans, query and pool metrics. A zero
// Instrumentation installs no tracer at all.
func OpenInstrumented(ctx context.Context, connectionURL string, instrumentation Instrumentation) (*pgxpool.Pool, error) {
	c, err := poolConfig(connectionURL)
	if err != nil {
		return nil, err
	}

	var t *tracer
	if instrumentation.TracerProvider != nil || instrumentation.MeterProvider != nil {
		if t, err = newTracer(instrumentation); err != nil {
			return nil, errors.New("could not create database instruments")
		}
		c.ConnConfig.Tracer = t
	}

	pool, err := pgxpool.NewWithConfig(ctx, c)
	if err != nil {
		return nil, errors.New("could not initialize PostgreSQL connection pool")
	}

	if t != nil {
		if err := t.observe(pool); err != nil {
			pool.Close()
			return nil, errors.New("could not create database instruments")
		}
	}

	return pool, nil
}

// poolConfig parses the URL. pgx reads pool_max_conns, pool_min_conns and
// its other pool_* parameters itself; only absent sizes get the defaults
// (pgx's own default maximum is 4).
func poolConfig(connectionURL string) (*pgxpool.Config, error) {
	invalid := errors.New("invalid PostgreSQL connection configuration")
	u, err := url.Parse(connectionURL)
	if err != nil {
		return nil, invalid
	}
	c, err := pgxpool.ParseConfig(connectionURL)
	if err != nil {
		return nil, invalid
	}

	query := u.Query()
	if !query.Has("pool_max_conns") {
		c.MaxConns = DefaultMaxConns
	}
	if !query.Has("pool_min_conns") {
		c.MinConns = DefaultMinConns
	}
	if c.MinConns < 0 || c.MinConns > c.MaxConns {
		return nil, errors.New("pool_min_conns must be between 0 and the maximum pool size")
	}

	c.ConnConfig.ConnectTimeout = 5 * time.Second
	c.ConnConfig.RuntimeParams["timezone"] = "UTC"
	c.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	c.ConnConfig.RuntimeParams["lock_timeout"] = "2000"
	return c, nil
}

// Ready fails when PostgreSQL is unreachable or the applied schema version is
// below MinSchemaVersion.
func Ready(ctx context.Context, pool *pgxpool.Pool) error {
	if err := pool.Ping(ctx); err != nil {
		return errors.New("database unavailable")
	}

	// The name comment labels the query in telemetry, like sqlc's queries.
	var version int64
	err := pool.QueryRow(ctx, `-- name: ReadySchemaVersion :one
SELECT COALESCE(MAX(version_id), 0) FROM (
SELECT DISTINCT ON (version_id) version_id, is_applied
FROM public.goose_db_version ORDER BY version_id, id DESC
) AS latest WHERE is_applied`).Scan(&version)

	if err != nil {
		return errors.New("database schema version unavailable")
	}
	if version < MinSchemaVersion {
		return errors.New("database schema is older than this API requires")
	}

	return nil
}
