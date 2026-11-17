//go:build integration

package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/clientip"

	"github.com/go-chi/chi/v5"
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

	// Review H1 (M17 task 6): an IPv6 client is its /64 and a site its /48,
	// across tasks. Login checks the IP limits before reading the body, so an
	// empty body answers 400 when admitted and 429 when limited.
	t.Run("IPv6 prefixes hold across instances", func(t *testing.T) {
		const origin = "https://shop.example.test"
		handler := func(shared *auth.SharedLimits) http.Handler {
			service, err := auth.NewService(f.pool, []byte(strings.Repeat("prefix-test-key-", 2)), func() time.Time { return now.Add(time.Hour) })
			if err != nil {
				t.Fatal(err)
			}
			router := chi.NewRouter()
			auth.NewHandler(service, auth.HTTPOptions{Origin: origin, ClientIP: clientip.CloudFront, SharedLimits: shared}).Routes(router)
			return router
		}
		tasks := []http.Handler{handler(first), handler(second)}
		limited := func(i int, viewer string) bool {
			r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
			r.Header.Set("Origin", origin)
			r.Header.Set("X-CSRF-Protection", "1")
			r.Header.Set(clientip.ViewerAddressHeader, viewer)
			w := httptest.NewRecorder()
			tasks[i%2].ServeHTTP(w, r)
			if w.Code != http.StatusTooManyRequests && w.Code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400 or 429", w.Code)
			}
			return w.Code == http.StatusTooManyRequests
		}

		// One /64, a new address on every request, alternating tasks.
		for i := range 21 {
			if limited(i, fmt.Sprintf("2001:db8:a:1::%x:443", i+1)) != (i >= 20) {
				t.Fatalf("request %d from one /64: the client limit did not hold", i+1)
			}
		}
		// More /64s in the same /48: the site admits 80 in all.
		admitted := 20
		for subnet := 2; subnet <= 10; subnet++ {
			for i := range 20 {
				if !limited(i, fmt.Sprintf("2001:db8:a:%x::%x:443", subnet, i+1)) {
					admitted++
				}
			}
		}
		if admitted != 80 {
			t.Fatalf("one /48 admitted %d across two tasks, want 80", admitted)
		}
		if limited(0, "2001:db8:b::1:443") {
			t.Fatal("another /48 was limited")
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
