package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// lockedBuffer collects log output written from server goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// requestLogs returns the decoded "http request" entries.
func (b *lockedBuffer) requestLogs(t *testing.T) []map[string]any {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	var entries []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.buf.String()), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("log line is not JSON: %v", err)
		}
		if entry["msg"] == "http request" {
			entries = append(entries, entry)
		}
	}
	return entries
}

// failOnContext mimics the cart handlers: it passes the request context to a
// dependency and maps whatever error comes back to a server error.
func failOnContext(status int, started chan<- struct{}) func(chi.Router) {
	return func(router chi.Router) {
		router.Get("/api/v1/cart", func(w http.ResponseWriter, r *http.Request) {
			if started != nil {
				close(started)
			}
			<-r.Context().Done()
			writeError(w, status, "outcome_unknown", "Request outcome is unavailable")
		})
	}
}

func TestClientCancellationLoggedAs499(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusServiceUnavailable} {
		logs := &lockedBuffer{}
		server := New("127.0.0.1:8080", func(context.Context) error { return nil }, slog.New(slog.NewJSONHandler(logs, nil)), failOnContext(status, nil))
		ctx, cancel := context.WithCancel(context.Background())
		cancel() // the client is already gone when the dependency is called
		server.Handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/cart", nil).WithContext(ctx))

		entries := logs.requestLogs(t)
		if len(entries) != 1 {
			t.Fatalf("got %d request logs", len(entries))
		}
		e := entries[0]
		if e["status"] != float64(499) || e["client_closed"] != true || e["handler_status"] != float64(status) {
			t.Fatalf("handler %d logged as %v", status, e)
		}
	}
}

func TestDeadlineIsNotClientCancellation(t *testing.T) {
	logs := &lockedBuffer{}
	server := New("127.0.0.1:8080", func(context.Context) error { return nil }, slog.New(slog.NewJSONHandler(logs, nil)), failOnContext(http.StatusServiceUnavailable, nil))
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	server.Handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/cart", nil).WithContext(ctx))

	e := logs.requestLogs(t)[0]
	if e["status"] != float64(http.StatusServiceUnavailable) || e["client_closed"] != nil {
		t.Fatalf("deadline logged as %v", e)
	}
}

func TestCompletedRequestsKeepTheirStatus(t *testing.T) {
	logs := &lockedBuffer{}
	server := New("127.0.0.1:8080", func(context.Context) error { return errors.New("down") }, slog.New(slog.NewJSONHandler(logs, nil)))
	for _, path := range []string{"/health/live", "/health/ready", "/api/v1/unknown"} {
		server.Handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	var statuses []float64
	for _, e := range logs.requestLogs(t) {
		if e["client_closed"] != nil {
			t.Fatalf("completed request marked client_closed: %v", e)
		}
		statuses = append(statuses, e["status"].(float64))
	}
	if len(statuses) != 3 || statuses[0] != 200 || statuses[1] != 503 || statuses[2] != 404 {
		t.Fatalf("statuses %v", statuses)
	}
}

// TestNetworkCancellationLoggedAs499 cancels a real HTTP request mid-flight,
// as a browser does when navigating away, and checks the logged status.
func TestNetworkCancellationLoggedAs499(t *testing.T) {
	for _, http2 := range []bool{false, true} {
		name := "HTTP/1.1"
		if http2 {
			name = "HTTP/2 over TLS" // how browsers reach serve-https
		}
		t.Run(name, func(t *testing.T) { networkCancellation(t, http2) })
	}
}

func networkCancellation(t *testing.T, http2 bool) {
	logs := &lockedBuffer{}
	started := make(chan struct{})
	server := New("127.0.0.1:0", func(context.Context) error { return nil }, slog.New(slog.NewJSONHandler(logs, nil)), failOnContext(http.StatusInternalServerError, started))
	ts := httptest.NewUnstartedServer(server.Handler)
	if http2 {
		ts.EnableHTTP2 = true
		ts.StartTLS()
	} else {
		ts.Start()
	}
	defer ts.Close()
	client := ts.Client()

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/v1/cart", nil)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		response, err := client.Do(request)
		if err == nil {
			if http2 != (response.ProtoMajor == 2) {
				err = errors.New("unexpected protocol " + response.Proto)
			}
			_ = response.Body.Close()
		}
		result <- err
	}()
	<-started
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("client error = %v, want context.Canceled", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		if entries := logs.requestLogs(t); len(entries) == 1 {
			e := entries[0]
			if e["status"] != float64(499) || e["client_closed"] != true || e["handler_status"] != float64(http.StatusInternalServerError) {
				t.Fatalf("logged as %v", e)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("request was never logged")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
