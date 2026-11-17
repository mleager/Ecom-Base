package auth

import (
	"context"
	"net/http"
	"sync"
	"time"

	"ecom/backend/internal/platform/clientip"
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

// spent reports, without counting a request, whether key has used its
// budget for the current window. Limits that count only failures check it
// before the attempt and record each failure afterwards, so concurrent
// attempts can overshoot by the number in flight (bounded by the password
// hashing slots).
func (l *limiter) spent(ctx context.Context, key string, now time.Time) (time.Duration, bool) {
	var retry time.Duration
	var capacity bool
	if l.shared != nil {
		retry, capacity = l.shared.peek(ctx, l.name, key, l.limit, now)
	} else {
		l.mu.Lock()
		entry, exists := l.entries[key]
		l.mu.Unlock()
		if exists && now.Before(entry.reset) && entry.count >= l.limit {
			retry = entry.reset.Sub(now)
		}
	}
	switch {
	case capacity:
		l.metrics.RateLimited(ctx, l.name, metrics.LimitCapacity)
	case retry != 0:
		l.metrics.RateLimited(ctx, l.name, metrics.LimitThrottled)
	}
	return retry, capacity
}

// record counts one failure against key. A full key table or an unavailable
// store loses that count; spent then refuses the next attempt instead.
func (l *limiter) record(ctx context.Context, key string, now time.Time) {
	if l.shared != nil {
		l.shared.take(ctx, l.name, key, l.limit, l.window, now)
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	entry, exists := l.entries[key]
	if !exists || !now.Before(entry.reset) {
		if !exists && len(l.entries) >= 10000 {
			return
		}
		entry = bucket{reset: now.Add(l.window)}
	}
	if entry.count < l.limit {
		entry.count++
	}
	l.entries[key] = entry
}

func rateLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "60")
	writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many authentication requests; retry later")
}

func (h *Handler) allowIP(w http.ResponseWriter, r *http.Request) bool {
	return h.allowPeer(w, r, h.ipLimiter, h.ipSiteLimiter)
}

// allowPeer applies limits to the client (an IPv4 address or an IPv6 /64,
// see clientip.Key) and, when site is set, a looser limit to an IPv6
// client's /48. The site budget is spent only by requests the client limit
// admits.
func (h *Handler) allowPeer(w http.ResponseWriter, r *http.Request, limits, site *limiter) bool {
	address, ok := h.options.ClientIP.From(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_peer", "Invalid peer address")
		return false
	}

	now := h.service.now()
	if !limits.allow(r.Context(), clientip.Key(address), now) {
		rateLimited(w)
		return false
	}

	if key, ok := clientip.SiteKey(address); ok && site != nil && !site.allow(r.Context(), key, now) {
		rateLimited(w)
		return false
	}

	return true
}

// emailKeys returns the two keys of the email limits: the canonical email
// alone, and the email together with the client (an IPv4 address or an IPv6
// /64, see clientip.Key).
func (h *Handler) emailKeys(w http.ResponseWriter, r *http.Request, email string) (string, string, bool) {
	if len(email) > 254 {
		respondError(w, ErrInvalidInput)
		return "", "", false
	}

	address, ok := h.options.ClientIP.From(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_peer", "Invalid peer address")
		return "", "", false
	}

	email = canonicalEmail(email)
	return email, email + "\x00" + clientip.Key(address), true
}

// allowRegistration counts every registration attempt: 5 a minute per email
// and client, and 20 a minute per email from all clients. The email budget
// is spent only when the email-and-client budget admits.
func (h *Handler) allowRegistration(w http.ResponseWriter, r *http.Request, email string) bool {
	emailKey, clientKey, ok := h.emailKeys(w, r, email)
	if !ok {
		return false
	}

	now := h.service.now()
	if !h.emailClientLimiter.allow(r.Context(), clientKey, now) || !h.emailLimiter.allow(r.Context(), emailKey, now) {
		rateLimited(w)
		return false
	}

	return true
}

// signInFailures refuses a sign-in when the email's failure budget is
// spent, either from this client (5 a minute) or from all clients together
// (20 a minute). Only failed sign-ins count (recordSignInFailure), so a
// stranger cannot lock the owner out from the owner's own network, and
// successful sign-ins never use the budget.
func (h *Handler) signInFailures(w http.ResponseWriter, r *http.Request, email string) (func(), bool) {
	emailKey, clientKey, ok := h.emailKeys(w, r, email)
	if !ok {
		return nil, false
	}

	now := h.service.now()
	for _, check := range []struct {
		limits *limiter
		key    string
	}{{h.emailClientLimiter, clientKey}, {h.emailLimiter, emailKey}} {
		if retry, capacity := check.limits.spent(r.Context(), check.key, now); retry != 0 || capacity {
			rateLimited(w)
			return nil, false
		}
	}

	record := func() {
		// The failure counts even if the client has gone away meanwhile.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Second)
		defer cancel()
		now := h.service.now()
		h.emailClientLimiter.record(ctx, clientKey, now)
		h.emailLimiter.record(ctx, emailKey, now)
	}
	return record, true
}
