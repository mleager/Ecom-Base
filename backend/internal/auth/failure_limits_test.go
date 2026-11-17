package auth

import (
	"context"
	"testing"
	"time"
)

func TestFailureOnlyLimiter(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	l := newLimiter("auth_email_client", 5, nil, nil)

	if retry, capacity := l.spent(ctx, "key", now); retry != 0 || capacity {
		t.Fatal("an unknown key is spent")
	}
	for range 4 {
		l.record(ctx, "key", now)
	}
	if retry, _ := l.spent(ctx, "key", now); retry != 0 {
		t.Fatal("spent after 4 of 5 failures")
	}
	// Checking never counts.
	for range 10 {
		l.spent(ctx, "key", now)
	}
	l.record(ctx, "key", now)
	retry, _ := l.spent(ctx, "key", now.Add(10*time.Second))
	if retry != 50*time.Second {
		t.Fatalf("after 5 failures: retry %v, want 50s", retry)
	}
	if retry, _ := l.spent(ctx, "other", now); retry != 0 {
		t.Fatal("another key is spent")
	}
	// The window restarts after a minute.
	if retry, _ := l.spent(ctx, "key", now.Add(time.Minute)); retry != 0 {
		t.Fatal("still spent after the window")
	}
	l.record(ctx, "key", now.Add(time.Minute))
	if l.entries["key"].count != 1 {
		t.Fatalf("a new window starts at %d, want 1", l.entries["key"].count)
	}
}
