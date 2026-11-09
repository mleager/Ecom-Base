package database

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"ecom/backend/internal/platform/telemetry"
)

const testURL = "postgres://ecom_app:private-password@localhost:5432/ecom?sslmode=disable"

func TestPoolSizeFollowsURL(t *testing.T) {
	cases := []struct {
		query    string
		max, min int32
		invalid  bool
	}{
		{"", 10, 0, false},
		{"&pool_max_conns=25", 25, 0, false},
		{"&pool_min_conns=3", 10, 3, false},
		{"&pool_max_conns=4&pool_min_conns=4", 4, 4, false},
		{"&pool_max_conns=2&pool_min_conns=3", 0, 0, true},
		{"&pool_min_conns=11", 0, 0, true},
		{"&pool_max_conns=0", 0, 0, true},
		{"&pool_max_conns=many", 0, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.query, func(t *testing.T) {
			c, err := poolConfig(testURL + tc.query)
			if tc.invalid {
				if err == nil {
					t.Fatal("accepted an invalid pool size")
				}
				if strings.Contains(err.Error(), "private-password") {
					t.Fatal("error disclosed the password")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if c.MaxConns != tc.max || c.MinConns != tc.min {
				t.Fatalf("pool %d/%d, want %d/%d", c.MaxConns, c.MinConns, tc.max, tc.min)
			}
			if c.ConnConfig.RuntimeParams["statement_timeout"] != "5000" || c.ConnConfig.RuntimeParams["timezone"] != "UTC" {
				t.Fatal("runtime parameters lost")
			}
			if _, leaked := c.ConnConfig.RuntimeParams["pool_max_conns"]; leaked {
				t.Fatal("pool parameter sent to the server")
			}
		})
	}

	c, err := poolConfig(testURL + "&pool_max_conn_lifetime=90s")
	if err != nil || c.MaxConnLifetime.Seconds() != 90 {
		t.Fatal("other pgx pool parameters are not honored")
	}
}

func TestOperationName(t *testing.T) {
	for sql, want := range map[string]string{
		"-- name: GetProduct :one\nSELECT 1":   "GetProduct",
		"-- name: bad-name :one\nSELECT 1":     "SELECT",
		"-- name: \nselect 1":                  "SELECT",
		"begin":                                "BEGIN",
		"  commit":                             "COMMIT",
		"(SELECT 1) UNION (SELECT 2)":          "SELECT",
		"WITH x AS (SELECT 1) SELECT * FROM x": "WITH",
		"VACUUM products":                      "OTHER",
		"SELECT 'private'":                     "SELECT",
		"":                                     "OTHER",
	} {
		if got := operationName(sql); got != want {
			t.Fatalf("operationName(%q) = %q, want %q", sql, got, want)
		}
	}
	if got := queryText("-- name: GetProduct :one\nSELECT $1\n"); got != "SELECT $1" {
		t.Fatalf("queryText = %q", got)
	}
	if got := queryText(strings.Repeat("x", maxQueryText+10)); len(got) != maxQueryText {
		t.Fatalf("queryText length %d", len(got))
	}
}

func TestErrorType(t *testing.T) {
	for err, want := range map[error]string{
		&pgconn.PgError{Code: "23505", Message: "private", Detail: "Key (email)=(a@b)"}: "23505",
		fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: "40001"}):                       "40001",
		context.Canceled:             "canceled",
		context.DeadlineExceeded:     "timeout",
		errors.New("private detail"): "other",
	} {
		if got := errorType(err); got != want {
			t.Fatalf("errorType(%v) = %q, want %q", err, got, want)
		}
	}
}

type testTracer struct {
	*tracer
	spans  *tracetest.SpanRecorder
	reader *sdkmetric.ManualReader
	parent trace.Tracer
}

func newTestTracer(t *testing.T) *testTracer {
	t.Helper()
	spans := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	tr, err := newTracer(Instrumentation{TracerProvider: provider, MeterProvider: sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))})
	if err != nil {
		t.Fatal(err)
	}
	return &testTracer{tracer: tr, spans: spans, reader: reader, parent: provider.Tracer("test")}
}

func (tt *testTracer) metrics(t *testing.T) map[string][]attribute.Set {
	t.Helper()
	var data metricdata.ResourceMetrics
	if err := tt.reader.Collect(context.Background(), &data); err != nil {
		t.Fatal(err)
	}
	found := map[string][]attribute.Set{}
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			switch d := m.Data.(type) {
			case metricdata.Histogram[float64]:
				for _, p := range d.DataPoints {
					found[m.Name] = append(found[m.Name], p.Attributes)
				}
			case metricdata.Sum[int64]:
				for _, p := range d.DataPoints {
					found[m.Name] = append(found[m.Name], p.Attributes)
				}
			}
		}
	}
	return found
}

func attr(set []attribute.KeyValue, key string) string {
	for _, kv := range set {
		if string(kv.Key) == key {
			return kv.Value.Emit()
		}
	}
	return ""
}

func TestQuerySpansNestAndNeverRecordArguments(t *testing.T) {
	tt := newTestTracer(t)
	ctx, request := tt.parent.Start(context.Background(), "GET /api/v1/orders/{id}")
	sql := "-- name: GetOrder :one\nSELECT id FROM orders WHERE id = $1 AND email = $2\n"
	queryCtx := tt.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: sql, Args: []any{"private-order-id", "person@example.com"}})
	tt.TraceQueryEnd(queryCtx, nil, pgx.TraceQueryEndData{CommandTag: pgconn.NewCommandTag("SELECT 1")})
	request.End()

	ended := tt.spans.Ended()
	if len(ended) != 2 {
		t.Fatalf("%d spans, want 2", len(ended))
	}
	query := ended[0]
	if query.Name() != "GetOrder" || query.SpanKind() != trace.SpanKindClient || query.Parent().SpanID() != request.SpanContext().SpanID() {
		t.Fatalf("query span %q kind %v parent %v", query.Name(), query.SpanKind(), query.Parent().SpanID())
	}
	if attr(query.Attributes(), "db.system.name") != "postgresql" || attr(query.Attributes(), "db.operation.name") != "GetOrder" ||
		attr(query.Attributes(), "db.query.text") != "SELECT id FROM orders WHERE id = $1 AND email = $2" {
		t.Fatalf("attributes %v", query.Attributes())
	}
	recorded := fmt.Sprint(query.Name(), query.Attributes(), query.Events(), query.Status(), tt.metrics(t))
	for _, forbidden := range []string{"private-order-id", "person@example.com"} {
		if strings.Contains(recorded, forbidden) {
			t.Fatalf("argument %q recorded", forbidden)
		}
	}
}

func TestQueriesWithoutASpanOnlyRecordMetrics(t *testing.T) {
	tt := newTestTracer(t)
	ctx := tt.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "-- name: ReadySchemaVersion :one\nSELECT 1"})
	tt.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
	if len(tt.spans.Ended()) != 0 {
		t.Fatal("a root span was created for an untraced query")
	}
	durations := tt.metrics(t)["db.client.operation.duration"]
	if len(durations) != 1 || durations[0].Len() != 2 {
		t.Fatalf("duration series %v", durations)
	}
	if v, _ := durations[0].Value("db.operation.name"); v.AsString() != "ReadySchemaVersion" {
		t.Fatalf("operation label %v", durations[0].ToSlice())
	}
}

func TestQueryErrorsRecordOnlyTheCode(t *testing.T) {
	tt := newTestTracer(t)
	ctx, request := tt.parent.Start(context.Background(), "POST /api/v1/auth/register")
	queryCtx := tt.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: "-- name: CreateUser :one\nINSERT INTO users(email) VALUES ($1)", Args: []any{"person@example.com"}})
	tt.TraceQueryEnd(queryCtx, nil, pgx.TraceQueryEndData{Err: &pgconn.PgError{Code: "23505", Message: "duplicate key", Detail: "Key (email)=(person@example.com) already exists."}})
	request.End()

	query := tt.spans.Ended()[0]
	if query.Status().Code != codes.Error || query.Status().Description != "" || attr(query.Attributes(), "error.type") != "23505" {
		t.Fatalf("error span %v %v", query.Status(), query.Attributes())
	}
	if recorded := fmt.Sprint(query.Attributes(), query.Events(), tt.metrics(t)); strings.Contains(recorded, "person@example.com") || strings.Contains(recorded, "duplicate") {
		t.Fatal("error message or detail recorded")
	}
}

func TestAcquireMetrics(t *testing.T) {
	tt := newTestTracer(t)
	ctx := tt.TraceAcquireStart(context.Background(), nil, pgxpool.TraceAcquireStartData{})
	if pending := tt.metrics(t)["db.client.connection.pending_requests"]; len(pending) != 1 {
		t.Fatalf("pending series %v", pending)
	}
	tt.TraceAcquireEnd(ctx, nil, pgxpool.TraceAcquireEndData{})
	ctx = tt.TraceAcquireStart(context.Background(), nil, pgxpool.TraceAcquireStartData{})
	tt.TraceAcquireEnd(ctx, nil, pgxpool.TraceAcquireEndData{Err: context.DeadlineExceeded})

	found := tt.metrics(t)
	waits := map[string]bool{}
	for _, set := range found["db.client.connection.wait_time"] {
		v, _ := set.Value("error.type")
		waits[v.AsString()] = true
	}
	if !waits[""] || !waits["timeout"] || len(waits) != 2 {
		t.Fatalf("wait_time series %v", found["db.client.connection.wait_time"])
	}
}

// The names scrapers see on METRICS_ADDR. The pool connects lazily, so no
// database is needed.
func TestPrometheusNames(t *testing.T) {
	tel, err := telemetry.Start(context.Background(), telemetry.Settings{MetricsAddress: "127.0.0.1:0", Getenv: func(string) string { return "" }})
	if err != nil {
		t.Fatal(err)
	}
	defer tel.Shutdown(context.Background())
	pool, err := OpenInstrumented(context.Background(), testURL+"&pool_max_conns=7", Instrumentation{MeterProvider: tel.MeterProvider})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tr := pool.Config().ConnConfig.Tracer.(*tracer)
	ctx := tr.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "-- name: GetProduct :one\nSELECT 1"})
	tr.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
	ctx = tr.TraceAcquireStart(context.Background(), nil, pgxpool.TraceAcquireStartData{})
	tr.TraceAcquireEnd(ctx, nil, pgxpool.TraceAcquireEndData{})

	response, err := http.Get("http://" + tel.MetricsAddr().String() + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	for _, want := range []string{
		`db_client_operation_duration_seconds_count{db_operation_name="GetProduct",db_system_name="postgresql"} 1`,
		`db_client_connection_wait_time_seconds_count{db_client_connection_pool_name="main"} 1`,
		`db_client_connection_pending_requests{db_client_connection_pool_name="main"} 0`,
		`db_client_connection_count{db_client_connection_pool_name="main",db_client_connection_state="idle"} 0`,
		`db_client_connection_count{db_client_connection_pool_name="main",db_client_connection_state="used"} 0`,
		`db_client_connection_max{db_client_connection_pool_name="main"} 7`,
		`db_client_connection_idle_min{db_client_connection_pool_name="main"} 0`,
		`db_client_connection_timeouts_total{db_client_connection_pool_name="main"} 0`,
	} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("metrics lack %s:\n%s", want, body)
		}
	}
}
