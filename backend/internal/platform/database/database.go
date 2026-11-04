package database

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const SchemaVersion int64 = 13

func Open(ctx context.Context, connectionURL string) (*pgxpool.Pool, error) {
	c, err := pgxpool.ParseConfig(connectionURL)
	if err != nil {
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}

	c.MaxConns = 10
	c.MinConns = 0
	c.ConnConfig.ConnectTimeout = 5 * time.Second
	c.ConnConfig.RuntimeParams["timezone"] = "UTC"
	c.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	c.ConnConfig.RuntimeParams["lock_timeout"] = "2000"

	pool, err := pgxpool.NewWithConfig(ctx, c)
	if err != nil {
		return nil, errors.New("could not initialize PostgreSQL connection pool")
	}

	return pool, nil
}

func Ready(ctx context.Context, pool *pgxpool.Pool) error {
	if err := pool.Ping(ctx); err != nil {
		return errors.New("database unavailable")
	}

	var version int64
	err := pool.QueryRow(ctx, `SELECT COALESCE(MAX(version_id), 0) FROM (
SELECT DISTINCT ON (version_id) version_id, is_applied
FROM public.goose_db_version ORDER BY version_id, id DESC
) AS latest WHERE is_applied`).Scan(&version)

	if err != nil || version != SchemaVersion {
		return errors.New("database schema does not match this API")
	}

	return nil
}
