//go:build integration

package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ecom/backend/internal/auth"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Two API tasks are two processes with their own pools; one limit must hold
// across both (M17 task 3).
func TestSharedLimitsAcrossInstances(t *testing.T) {
	f := newTestDatabase(t)
	instance := func() *auth.SharedLimits {
		pool, err := pgxpool.New(f.ctx, f.appURL)
		if err != nil {
			t.Fatal("open runtime pool")
		}
		t.Cleanup(pool.Close)
		return auth.NewSharedLimits(pool, nil)
	}
	first, second := instance(), instance()
	now := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)

	t.Run("one limit across two instances", func(t *testing.T) {
		a := auth.NewRequestLimiter("guest_bootstrap", 5, time.Hour, nil, first)
		b := auth.NewRequestLimiter("guest_bootstrap", 5, time.Hour, nil, second)
		for i := range 10 {
			limiter := a
			if i%2 == 1 {
				limiter = b
			}
			retry, capacity := limiter.Check(f.ctx, "198.51.100.10", now)
			if capacity || (retry == 0) != (i < 5) {
				t.Fatalf("request %d: retry %v, capacity %v", i+1, retry, capacity)
			}
			if i >= 5 && (retry <= 0 || retry > time.Hour) {
				t.Fatalf("retry %v outside the window", retry)
			}
		}
		// Another key and another limiter name have their own budgets.
		if retry, _ := a.Check(f.ctx, "198.51.100.11", now); retry != 0 {
			t.Fatal("another key was limited")
		}
		other := auth.NewRequestLimiter("guest_read", 5, time.Hour, nil, second)
		if retry, _ := other.Check(f.ctx, "198.51.100.10", now); retry != 0 {
			t.Fatal("another limiter shared the key's budget")
		}
		// The window ends for both instances at once.
		if retry, _ := b.Check(f.ctx, "198.51.100.10", now.Add(time.Hour)); retry != 0 {
			t.Fatal("a new window did not admit")
		}
		if retry, _ := a.Check(f.ctx, "198.51.100.10", now.Add(time.Hour)); retry != 0 {
			t.Fatal("the new window was not shared")
		}
	})

	t.Run("concurrent requests admit exactly the limit", func(t *testing.T) {
		a := auth.NewRequestLimiter("auth_ip", 20, time.Minute, nil, first)
		b := auth.NewRequestLimiter("auth_ip", 20, time.Minute, nil, second)
		var admitted atomic.Int32
		var wg sync.WaitGroup
		for i := range 60 {
			limiter := a
			if i%2 == 1 {
				limiter = b
			}
			wg.Go(func() {
				if retry, capacity := limiter.Check(f.ctx, "203.0.113.5", now); retry == 0 && !capacity {
					admitted.Add(1)
				}
			})
		}
		wg.Wait()
		if got := admitted.Load(); got != 20 {
			t.Fatalf("admitted %d of 60 concurrent requests, want 20", got)
		}
	})

	t.Run("keys are stored only as digests", func(t *testing.T) {
		const key = "person@example.com"
		a := auth.NewRequestLimiter("auth_email", 5, time.Minute, nil, first)
		if retry, _ := a.Check(f.ctx, key, now); retry != 0 {
			t.Fatal("first request limited")
		}
		var digest []byte
		var count int
		if err := f.pool.QueryRow(f.ctx, `SELECT key_digest, count FROM rate_limit_buckets WHERE limiter='auth_email'`).Scan(&digest, &count); err != nil {
			t.Fatal(err)
		}
		want := sha256.Sum256([]byte(key))
		if !bytes.Equal(digest, want[:]) || count != 1 {
			t.Fatal("stored key is not the SHA-256 digest")
		}
		var raw bool
		if err := f.pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM rate_limit_buckets b WHERE position(convert_to($1,'UTF8') in b.key_digest) > 0 OR b.limiter = $1)`, key).Scan(&raw); err != nil || raw {
			t.Fatal("raw key stored")
		}
	})

	t.Run("expired rows are swept", func(t *testing.T) {
		later := now.Add(48 * time.Hour)
		// A new instance sweeps on its first request.
		third := instance()
		limiter := auth.NewRequestLimiter("security_ip", 20, time.Minute, nil, third)
		if retry, _ := limiter.Check(f.ctx, "192.0.2.1", later); retry != 0 {
			t.Fatal("request limited")
		}
		var expired, live int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FILTER (WHERE reset_at <= $1), count(*) FILTER (WHERE reset_at > $1) FROM rate_limit_buckets`, later).Scan(&expired, &live); err != nil {
			t.Fatal(err)
		}
		if expired != 0 || live != 1 {
			t.Fatalf("after sweep: %d expired and %d live rows, want 0 and 1", expired, live)
		}
	})

	t.Run("an unavailable database refuses, never admits", func(t *testing.T) {
		pool, err := pgxpool.New(f.ctx, f.appURL)
		if err != nil {
			t.Fatal(err)
		}
		pool.Close()
		limiter := auth.NewRequestLimiter("guest_write", 30, time.Minute, nil, auth.NewSharedLimits(pool, nil))
		retry, capacity := limiter.Check(context.Background(), "198.51.100.10", now)
		if retry == 0 || !capacity {
			t.Fatalf("closed pool: retry %v, capacity %v; want a capacity refusal", retry, capacity)
		}
	})
}
