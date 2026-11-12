package auth

import (
	"context"
	"crypto/sha256"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SharedLimits keeps request-limit counters in PostgreSQL
// (rate_limit_buckets, migration 14), so every API task that uses the same
// database enforces one limit per key. Concurrency slots stay per process.
type SharedLimits struct {
	pool   *pgxpool.Pool
	logger *slog.Logger

	mu        sync.Mutex
	nextSweep time.Time
}

// NewSharedLimits uses the runtime pool. A nil logger discards store errors.
func NewSharedLimits(pool *pgxpool.Pool, logger *slog.Logger) *SharedLimits {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &SharedLimits{pool: pool, logger: logger}
}

// sweepEvery and sweepBatch bound the cleanup of expired rows that each
// process does inline.
const (
	sweepEvery = time.Minute
	sweepBatch = 1000
)

// One statement admits or rejects. A rejected key's count stays at limit+1,
// so a rejection is count > limit; an expired window starts again at 1.
const takeSQL = `INSERT INTO rate_limit_buckets AS b (limiter, key_digest, count, reset_at)
VALUES ($1, $2, 1, $4)
ON CONFLICT (limiter, key_digest) DO UPDATE SET
 count = CASE WHEN b.reset_at <= $3 THEN 1 ELSE least(b.count + 1, $5 + 1) END,
 reset_at = CASE WHEN b.reset_at <= $3 THEN EXCLUDED.reset_at ELSE b.reset_at END
RETURNING count, reset_at`

const sweepSQL = `DELETE FROM rate_limit_buckets WHERE ctid IN (
 SELECT ctid FROM rate_limit_buckets WHERE reset_at <= $1 LIMIT $2)`

// take returns the same values as limiter.check. When the database cannot
// answer, it reports capacity: the request is refused, never admitted
// without a limit.
func (s *SharedLimits) take(ctx context.Context, name, key string, limit int, window time.Duration, now time.Time) (time.Duration, bool) {
	digest := sha256.Sum256([]byte(key))
	var count int
	var reset time.Time
	err := s.pool.QueryRow(ctx, takeSQL, name, digest[:], now, now.Add(window), limit).Scan(&count, &reset)
	if err != nil {
		if ctx.Err() == nil {
			s.logger.Warn("shared rate limit unavailable", "limiter", name, "error", err.Error())
		}
		return 5 * time.Second, true
	}

	s.sweep(ctx, now)

	if count > limit {
		return max(reset.Sub(now), time.Millisecond), false
	}
	return 0, false
}

func (s *SharedLimits) sweep(ctx context.Context, now time.Time) {
	s.mu.Lock()
	due := !now.Before(s.nextSweep)
	if due {
		s.nextSweep = now.Add(sweepEvery)
	}
	s.mu.Unlock()
	if !due {
		return
	}
	if _, err := s.pool.Exec(ctx, sweepSQL, now, sweepBatch); err != nil && ctx.Err() == nil {
		s.logger.Warn("shared rate limit cleanup failed", "error", err.Error())
	}
}
