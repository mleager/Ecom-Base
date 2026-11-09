//go:build integration

package integration

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"
)

func withQuery(t *testing.T, connectionURL string, values map[string]string) string {
	t.Helper()
	u, err := url.Parse(connectionURL)
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	for key, value := range values {
		query.Set(key, value)
	}
	u.RawQuery = query.Encode()
	return u.String()
}

// Task 4 gates: query spans nest under request spans, arguments are never
// exported, and the pool size follows pool_max_conns in the URL.
func TestDatabaseTelemetry(t *testing.T) {
	f := newTestDatabase(t)

	t.Run("pool size follows the URL", func(t *testing.T) {
		if got := f.pool.Config().MaxConns; got != database.DefaultMaxConns {
			t.Fatalf("default pool size %d", got)
		}
		pool, err := database.Open(f.ctx, withQuery(t, f.appURL, map[string]string{"pool_max_conns": "3", "pool_min_conns": "1"}))
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()
		if pool.Config().MaxConns != 3 || pool.Config().MinConns != 1 {
			t.Fatalf("pool %d/%d, want 3/1", pool.Config().MaxConns, pool.Config().MinConns)
		}
		if err := database.Ready(f.ctx, pool); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Open(f.ctx, withQuery(t, f.appURL, map[string]string{"pool_max_conns": "2", "pool_min_conns": "3"})); err == nil {
			t.Fatal("minimum above maximum accepted")
		}
	})

	t.Run("query spans nest under the request span", func(t *testing.T) {
		spans := tracetest.NewSpanRecorder()
		reader := sdkmetric.NewManualReader()
		tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
		meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
		pool, err := database.OpenInstrumented(f.ctx, withQuery(t, f.appURL, map[string]string{"pool_max_conns": "4"}),
			database.Instrumentation{TracerProvider: tracerProvider, MeterProvider: meterProvider})
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()

		const secret = "private-argument-7f3c"
		routes := func(router chi.Router) {
			router.Get("/api/v1/probe/{id}", func(w http.ResponseWriter, r *http.Request) {
				tx, err := pool.Begin(r.Context())
				if err != nil {
					http.Error(w, "begin", http.StatusInternalServerError)
					return
				}
				defer tx.Rollback(r.Context())
				var id pgtype.UUID
				_ = id.Scan("00000000-0000-4000-8000-00000000abcd")
				if _, err := db.New(tx).GetProduct(r.Context(), id); !errors.Is(err, pgx.ErrNoRows) {
					http.Error(w, "query", http.StatusInternalServerError)
					return
				}
				var echoed string
				if err := tx.QueryRow(r.Context(), "SELECT $1::text", secret).Scan(&echoed); err != nil || echoed != secret {
					http.Error(w, "echo", http.StatusInternalServerError)
					return
				}
				if err := tx.Commit(r.Context()); err != nil {
					http.Error(w, "commit", http.StatusInternalServerError)
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})
		}
		server, err := httpserver.NewInstrumented("127.0.0.1:0", nil, slog.New(slog.DiscardHandler),
			httpserver.Instrumentation{TracerProvider: tracerProvider, MeterProvider: meterProvider, Propagator: propagation.TraceContext{}}, routes)
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/probe/"+secret, nil))
		if response.Code != http.StatusNoContent {
			t.Fatalf("probe status %d: %s", response.Code, response.Body.String())
		}

		var request trace.SpanContext
		var names []string
		children := map[string]string{}
		for _, span := range spans.Ended() {
			if span.SpanKind() == trace.SpanKindServer {
				request = span.SpanContext()
				if span.Name() != "GET /api/v1/probe/{id}" {
					t.Fatalf("server span %q", span.Name())
				}
			}
		}
		for _, span := range spans.Ended() {
			if span.SpanKind() != trace.SpanKindClient {
				continue
			}
			names = append(names, span.Name())
			if span.Parent().SpanID() != request.SpanID() || span.SpanContext().TraceID() != request.TraceID() {
				t.Fatalf("query span %q is not a child of the request span", span.Name())
			}
			for _, kv := range span.Attributes() {
				if kv.Key == "db.query.text" {
					children[span.Name()] = kv.Value.AsString()
				}
			}
		}
		if strings.Join(names, ",") != "BEGIN,GetProduct,SELECT,COMMIT" {
			t.Fatalf("query spans %v", names)
		}
		if children["SELECT"] != "SELECT $1::text" || !strings.Contains(children["GetProduct"], "WHERE p.id = $1") {
			t.Fatalf("statement text %v", children)
		}

		var data metricdata.ResourceMetrics
		if err := reader.Collect(context.Background(), &data); err != nil {
			t.Fatal(err)
		}
		var everything strings.Builder
		for _, span := range spans.Ended() {
			fmt.Fprint(&everything, span.Name(), span.Attributes(), span.Events(), span.Status())
		}
		fmt.Fprintf(&everything, "%+v", data)
		if strings.Contains(everything.String(), secret) {
			t.Fatal("a query argument or the raw URL was recorded")
		}

		gauges := map[string]int64{}
		operations := map[string]bool{}
		for _, scope := range data.ScopeMetrics {
			for _, m := range scope.Metrics {
				switch d := m.Data.(type) {
				case metricdata.Sum[int64]:
					for _, p := range d.DataPoints {
						state, _ := p.Attributes.Value("db.client.connection.state")
						gauges[m.Name+":"+state.AsString()] = p.Value
					}
				case metricdata.Histogram[float64]:
					if m.Name == "db.client.operation.duration" {
						for _, p := range d.DataPoints {
							name, _ := p.Attributes.Value("db.operation.name")
							operations[name.AsString()] = true
						}
					}
				}
			}
		}
		if gauges["db.client.connection.max:"] != 4 || gauges["db.client.connection.count:used"] != 0 || gauges["db.client.connection.count:idle"] < 1 {
			t.Fatalf("pool gauges %v", gauges)
		}
		for _, want := range []string{"BEGIN", "GetProduct", "SELECT", "COMMIT"} {
			if !operations[want] {
				t.Fatalf("operation %q missing from %v", want, operations)
			}
		}
	})
}
