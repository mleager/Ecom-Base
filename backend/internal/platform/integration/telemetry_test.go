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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/email"
	"ecom/backend/internal/platform/httpserver"
	"ecom/backend/internal/platform/metrics/metricstest"
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

// Task 5: real account and guest checkouts and a guest session move the
// business counters; replays do not.
func TestBusinessMetrics(t *testing.T) {
	f := newTestDatabase(t)
	recorder, reader, _ := metricstest.New(t)

	service := checkout.NewService(f.pool).UseMetrics(recorder)
	product := seedCheckoutProduct(t, f, 20, 500)
	for _, scenario := range []string{"accept", "reject"} {
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		c.request.PaymentScenario = scenario
		key := checkoutID(t)
		if _, err := service.Checkout(f.ctx, c.user, key, c.request); err != nil {
			t.Fatal(err)
		}
		replay, err := service.Checkout(f.ctx, c.user, key, c.request)
		if err != nil || !replay.Replayed {
			t.Fatalf("replay %v %v", replay.Replayed, err)
		}
	}

	authentication, err := auth.NewService(f.pool, []byte(strings.Repeat("test-key", 4)), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.DiscardHandler)
	options := auth.HTTPOptions{Origin: authTestOrigin, Metrics: recorder}
	a := auth.NewHandler(authentication, options)
	g := commerce.NewGuestHandler(commerce.NewService(f.pool), a.Authenticate, options)
	guest := checkout.NewGuestHandler(checkout.NewGuestService(service, email.Disabled{}, authTestOrigin), g, false)
	server := httptest.NewServer(httpserver.New("127.0.0.1:0", func(context.Context) error { return nil }, logger, a.RoutesWith(g.Routes, guest.Routes)).Handler)
	defer server.Close()
	api := authAPI{server}

	purchase := makeGuestPurchase(t, api, product, "accept", "guest@example.test")
	purchase.prepare(t, api, 201)
	purchase.place(t, api, 201)
	purchase.place(t, api, 200) // replay

	got := metricstest.Counters(t, reader)
	for key, want := range map[string]int64{
		"ecom.orders.created{customer.type=account}":                                   2,
		"ecom.orders.created{customer.type=guest}":                                     1,
		"ecom.payment.results{payment.result=accepted}":                                2,
		"ecom.payment.results{payment.result=rejected}":                                1,
		"ecom.guest.sessions.created{}":                                                1,
		"ecom.checkout.unknown_outcomes{customer.type=guest,outcome.reason=uncertain}": 0,
	} {
		if got[key] != want {
			t.Fatalf("%s = %d, want %d (all: %v)", key, got[key], want, got)
		}
	}
	for key := range got {
		if strings.Contains(key, "guest@example.test") || strings.Contains(key, product) {
			t.Fatalf("private value in label %s", key)
		}
	}
}

// M15 gate 2: an account checkout and a guest checkout each produce one
// trace, from the HTTP server span through its query spans, plus an SMTP
// span where mail is sent, and none of the forbidden data is recorded.
func TestCheckoutTraces(t *testing.T) {
	f := newTestDatabase(t)
	spans := tracetest.NewSpanRecorder()
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	pool, err := database.OpenInstrumented(f.ctx, f.appURL, database.Instrumentation{TracerProvider: tracerProvider})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	mail := &captureSecurityMail{}
	sender := email.Instrument(mail, email.Config{Host: "smtp.example.test", Port: "587"}, tracerProvider, nil)
	authentication, err := auth.NewService(pool, []byte(strings.Repeat("test-key", 4)), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.DiscardHandler)
	options := auth.HTTPOptions{Origin: authTestOrigin}
	a := auth.NewHandler(authentication, options)
	service := checkout.NewService(pool)
	g := commerce.NewGuestHandler(commerce.NewService(pool), a.Authenticate, options)
	routes := a.RoutesWith(
		commerce.NewHandler(commerce.NewService(pool), a.Authenticate).Routes,
		checkout.NewHandler(service, a.Authenticate, logger).Routes,
		g.Routes,
		checkout.NewGuestHandler(checkout.NewGuestService(service, sender, authTestOrigin), g, false).Routes,
	)
	server, err := httpserver.NewInstrumented("127.0.0.1:0", func(context.Context) error { return nil }, logger,
		httpserver.Instrumentation{TracerProvider: tracerProvider, Propagator: propagation.TraceContext{}}, routes)
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler)
	defer httpServer.Close()
	api := authAPI{httpServer}

	product := seedCheckoutProduct(t, f, 10, 1500)
	const accountEmail, guestEmail = "trace-account@example.com", "trace-guest@example.test"
	customer, token := httpCustomer(t, f, api, accountEmail, product)
	orderRequest(t, api, "POST", "/api/v1/checkout", requestJSON(t, customer.request), token, []string{"trace-account-key"}, 201)
	purchase := makeGuestPurchase(t, api, product, "accept", guestEmail)
	purchase.prepare(t, api, 201)
	purchase.place(t, api, 201)
	if len(mail.messages) != 1 {
		t.Fatalf("%d guest mails sent, want the receipt", len(mail.messages))
	}

	ended := spans.Ended()
	for _, route := range []string{"POST /api/v1/checkout", "POST /api/v1/guest/checkout"} {
		var root sdktrace.ReadOnlySpan
		for _, span := range ended {
			if span.Name() == route && span.SpanKind() == trace.SpanKindServer {
				if root != nil {
					t.Fatalf("two %s server spans", route)
				}
				root = span
			}
		}
		if root == nil {
			t.Fatalf("no %s server span", route)
		}
		members := map[trace.SpanID]bool{root.SpanContext().SpanID(): true}
		var queries, smtp int
		for _, span := range ended {
			if span.SpanContext().TraceID() != root.SpanContext().TraceID() || span == root {
				continue
			}
			members[span.SpanContext().SpanID()] = true
			switch {
			case span.Name() == "smtp send":
				smtp++
			case span.SpanKind() == trace.SpanKindClient:
				queries++
			default:
				t.Fatalf("%s trace holds unexpected span %q", route, span.Name())
			}
		}
		for _, span := range ended {
			if span.SpanContext().TraceID() == root.SpanContext().TraceID() && span != root && !members[span.Parent().SpanID()] {
				t.Fatalf("%s span %q has a parent outside the trace", route, span.Name())
			}
		}
		if root.Parent().IsValid() || queries < 5 {
			t.Fatalf("%s trace: root parent %v, %d query spans", route, root.Parent().IsValid(), queries)
		}
		wantSMTP := 0
		if route == "POST /api/v1/guest/checkout" {
			wantSMTP = 1
		}
		if smtp != wantSMTP {
			t.Fatalf("%s trace has %d smtp spans, want %d", route, smtp, wantSMTP)
		}
	}

	var everything strings.Builder
	for _, span := range ended {
		fmt.Fprint(&everything, span.Name(), span.Attributes(), span.Events(), span.Status(), span.Links())
	}
	for _, private := range []string{accountEmail, guestEmail, "Sensitive Recipient", "123 Private Shipping Road", "Guest Buyer", "10 Main St", "97201",
		authTestPassword, token, "Bearer", purchase.cookie.Value, "trace-account-key", mail.messages[0].Subject} {
		if strings.Contains(everything.String(), private) {
			t.Fatalf("spans recorded forbidden data %q", private)
		}
	}
}
