package httpserver

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthAndErrors(t *testing.T) {
	var logs bytes.Buffer
	calls := 0
	server := New("127.0.0.1:8080", func(ctx context.Context) error {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("readiness has no deadline")
		}
		return errors.New("private database diagnostic")
	}, slog.New(slog.NewJSONHandler(&logs, nil)))
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{http.MethodGet, "/health/live", http.StatusOK},
		{http.MethodGet, "/health/ready", http.StatusServiceUnavailable},
		{http.MethodPost, "/health/live", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/v1/health/live?secret=private", http.StatusNotFound},
		{http.MethodGet, "/api/v1/checkout", http.StatusNotFound},
	} {
		w := httptest.NewRecorder()
		server.Handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Fatalf("%s: got %d, want %d", tc.path, w.Code, tc.status)
		}
		if len(w.Header().Get("X-Request-ID")) != 32 {
			t.Fatal("response missing generated request ID")
		}
		if strings.Contains(w.Body.String(), "private") {
			t.Fatal("response disclosed internal error")
		}
	}
	if calls != 1 || strings.Contains(logs.String(), "private") {
		t.Fatal("liveness queried the database or logs disclosed a secret")
	}
}

func TestReadyAndPanic(t *testing.T) {
	for _, panics := range []bool{false, true} {
		var logs bytes.Buffer
		server := New("127.0.0.1:8080", func(context.Context) error {
			if panics {
				panic("private panic detail")
			}
			return nil
		}, slog.New(slog.NewJSONHandler(&logs, nil)))
		w := httptest.NewRecorder()
		server.Handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
		want := http.StatusOK
		if panics {
			want = http.StatusInternalServerError
		}
		if w.Code != want || strings.Contains(logs.String()+w.Body.String(), "private") {
			t.Fatal("readiness or panic handling failed")
		}
	}
}
