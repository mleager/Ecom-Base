package auth

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"ecom/backend/internal/platform/metrics/metricstest"
)

func TestLimiterRejectionsAreCounted(t *testing.T) {
	recorder, reader, _ := metricstest.New(t)
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)

	throttle := newLimiter("auth_email", 2, recorder, nil)
	for range 2 {
		if !throttle.allow(context.Background(), "person@example.com", now) {
			t.Fatal("rejected within the limit")
		}
	}
	if throttle.allow(context.Background(), "person@example.com", now) || throttle.allow(context.Background(), "person@example.com", now) {
		t.Fatal("allowed past the limit")
	}

	// A shared RequestLimiter reports a saturated key map as capacity.
	capacity := NewRequestLimiter("guest_bootstrap", 1, time.Hour, recorder, nil)
	for i := range 10000 {
		if retry, _ := capacity.Check(context.Background(), strconv.Itoa(i), now); retry != 0 {
			t.Fatal("rejected before capacity")
		}
	}
	if _, full := capacity.Check(context.Background(), "one-more", now); !full {
		t.Fatal("capacity not reported")
	}

	got := metricstest.Counters(t, reader)
	for key, want := range map[string]int64{
		"ecom.rate_limit.rejections{limiter.name=auth_email,limiter.reason=throttled}":      2,
		"ecom.rate_limit.rejections{limiter.name=auth_email,limiter.reason=capacity}":       0,
		"ecom.rate_limit.rejections{limiter.name=guest_bootstrap,limiter.reason=capacity}":  1,
		"ecom.rate_limit.rejections{limiter.name=guest_bootstrap,limiter.reason=throttled}": 0,
	} {
		if got[key] != want {
			t.Fatalf("%s = %d, want %d", key, got[key], want)
		}
	}
	for key := range got {
		for _, private := range []string{"person@example.com", "one-more", "9999"} {
			if strings.Contains(key, private) {
				t.Fatalf("limiter key %q became a label", private)
			}
		}
	}
}

func TestHandlerLimitersAreNamed(t *testing.T) {
	recorder, reader, _ := metricstest.New(t)
	NewHandler(nil, HTTPOptions{Metrics: recorder})
	got := metricstest.Counters(t, reader)
	for _, name := range []string{"auth_ip", "auth_ip_site", "auth_email", "auth_email_client", "security_ip", "security_user", "security_token", "password_reset_address"} {
		if _, ok := got["ecom.rate_limit.rejections{limiter.name="+name+",limiter.reason=throttled}"]; !ok {
			t.Fatalf("limiter %s has no series", name)
		}
	}
}
