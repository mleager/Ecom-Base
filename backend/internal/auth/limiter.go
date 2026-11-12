package auth

import (
	"context"
	"net/http"
	"sync"
	"time"

	"ecom/backend/internal/platform/metrics"
)

type bucket struct {
	count int
	reset time.Time
}

type limiter struct {
	mu        sync.Mutex
	entries   map[string]bucket
	limit     int
	window    time.Duration
	nextSweep time.Time
	// name labels rejections in ecom.rate_limit.rejections; fixed in code.
	name    string
	metrics *metrics.Recorder
	// shared, when set, keeps the counters in PostgreSQL instead of entries.
	shared *SharedLimits
}

func newLimiter(name string, limit int, recorder *metrics.Recorder, shared *SharedLimits) *limiter {
	return newWindowLimiter(name, limit, time.Minute, recorder, shared)
}

// newWindowLimiter keeps counters in this process unless shared is set.
func newWindowLimiter(name string, limit int, window time.Duration, recorder *metrics.Recorder, shared *SharedLimits) *limiter {
	recorder.LimiterCreated(name)
	return &limiter{entries: make(map[string]bucket), limit: limit, window: window, name: name, metrics: recorder, shared: shared}
}

func (l *limiter) allow(ctx context.Context, key string, now time.Time) bool {
	retry, _ := l.check(ctx, key, now)
	return retry == 0
}

// RequestLimiter shares the bounded admission implementation with guest routes.
// A positive retry is throttling; capacity distinguishes a saturated key map.
type RequestLimiter struct {
	limits *limiter
}

// NewRequestLimiter names the limiter for the rejection counter. A nil
// recorder counts nothing; a nil shared store keeps counters in this process.
func NewRequestLimiter(name string, limit int, window time.Duration, recorder *metrics.Recorder, shared *SharedLimits) *RequestLimiter {
	return &RequestLimiter{limits: newWindowLimiter(name, limit, window, recorder, shared)}
}

func (l *RequestLimiter) Check(ctx context.Context, key string, now time.Time) (time.Duration, bool) {
	return l.limits.check(ctx, key, now)
}

func (l *limiter) check(ctx context.Context, key string, now time.Time) (time.Duration, bool) {
	if l.shared != nil {
		retry, capacity := l.shared.take(ctx, l.name, key, l.limit, l.window, now)
		switch {
		case capacity:
			l.metrics.RateLimited(ctx, l.name, metrics.LimitCapacity)
		case retry != 0:
			l.metrics.RateLimited(ctx, l.name, metrics.LimitThrottled)
		}
		return retry, capacity
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	entry, exists := l.entries[key]
	if exists && !now.Before(entry.reset) {
		entry = bucket{}
	}

	if !exists && len(l.entries) >= 10000 {
		if !now.Before(l.nextSweep) {
			for key, value := range l.entries {
				if !now.Before(value.reset) {
					delete(l.entries, key)
				}
			}
			l.nextSweep = now.Add(time.Second)
		}
		if len(l.entries) >= 10000 {
			l.metrics.RateLimited(ctx, l.name, metrics.LimitCapacity)
			return 5 * time.Second, true
		}
	}

	if entry.count >= l.limit {
		l.metrics.RateLimited(ctx, l.name, metrics.LimitThrottled)
		return entry.reset.Sub(now), false
	}

	if entry.count == 0 {
		entry.reset = now.Add(l.window)
	}

	entry.count++
	l.entries[key] = entry

	return 0, false
}

func rateLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "60")
	writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many authentication requests; retry later")
}

func (h *Handler) allowIP(w http.ResponseWriter, r *http.Request) bool {
	return h.allowPeer(w, r, h.ipLimiter)
}

func (h *Handler) allowPeer(w http.ResponseWriter, r *http.Request, limits *limiter) bool {
	address, ok := h.options.ClientIP.From(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_peer", "Invalid peer address")
		return false
	}

	if !limits.allow(r.Context(), address.String(), h.service.now()) {
		rateLimited(w)
		return false
	}

	return true
}

func (h *Handler) allowEmail(w http.ResponseWriter, r *http.Request, email string) bool {
	if len(email) > 254 {
		respondError(w, ErrInvalidInput)
		return false
	}

	if !h.emailLimiter.allow(r.Context(), canonicalEmail(email), h.service.now()) {
		rateLimited(w)
		return false
	}

	return true
}
