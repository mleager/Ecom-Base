package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"ecom/backend/internal/platform/telemetry"
)

type harness struct {
	server *http.Server
	spans  *tracetest.SpanRecorder
	reader *sdkmetric.ManualReader
	logs   *bytes.Buffer
}

func testRoutes(router chi.Router) {
	router.Route("/api/v1", func(api chi.Router) {
		api.Get("/orders/{id}", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
		api.Post("/fail", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
		api.Get("/panic", func(http.ResponseWriter, *http.Request) { panic("private panic detail") })
		api.Get("/slow", func(w http.ResponseWriter, r *http.Request) {
			if r.Context().Err() != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
			}
		})
	})
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	spans := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	var logs bytes.Buffer
	static, err := newStatic(fstest.MapFS{"index.html": {Data: []byte("<html></html>")}})
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewInstrumented("127.0.0.1:0", func(context.Context) error { return nil },
		slog.New(telemetry.LogHandler(slog.NewJSONHandler(&logs, nil))),
		Instrumentation{
			TracerProvider: sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans)),
			MeterProvider:  sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)),
			Propagator:     propagation.TraceContext{},
		},
		testRoutes, SPA(static))
	if err != nil {
		t.Fatal(err)
	}
	return &harness{server: server, spans: spans, reader: reader, logs: &logs}
}

func (h *harness) do(r *http.Request) int {
	w := httptest.NewRecorder()
	h.server.Handler.ServeHTTP(w, r)
	return w.Code
}

// durations returns the attribute sets and counts of http.server.request.duration.
func (h *harness) durations(t *testing.T) []metricdata.HistogramDataPoint[float64] {
	t.Helper()
	var data metricdata.ResourceMetrics
	if err := h.reader.Collect(context.Background(), &data); err != nil {
		t.Fatal(err)
	}
	var points []metricdata.HistogramDataPoint[float64]
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "http.server.request.duration" {
				continue
			}
			if m.Unit != "s" {
				t.Fatalf("duration unit %q", m.Unit)
			}
			for _, point := range m.Data.(metricdata.Histogram[float64]).DataPoints {
				points = append(points, point)
			}
		}
	}
	return points
}

func value(set attribute.Set, key string) string {
	v, _ := set.Value(attribute.Key(key))
	return v.Emit()
}

func spanAttr(span sdktrace.ReadOnlySpan, key string) string {
	for _, kv := range span.Attributes() {
		if string(kv.Key) == key {
			return kv.Value.Emit()
		}
	}
	return ""
}

func TestSpanNamedByRoutePattern(t *testing.T) {
	h := newHarness(t)
	parent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	r := httptest.NewRequest(http.MethodGet, "/api/v1/orders/secret-123?token=private-token", nil)
	r.Header.Set("traceparent", parent)
	r.Header.Set("Authorization", "Bearer private-bearer")
	if status := h.do(r); status != http.StatusOK {
		t.Fatalf("status %d", status)
	}

	ended := h.spans.Ended()
	if len(ended) != 1 {
		t.Fatalf("%d spans, want 1", len(ended))
	}
	span := ended[0]
	if span.Name() != "GET /api/v1/orders/{id}" || span.SpanKind() != trace.SpanKindServer {
		t.Fatalf("span %q kind %v", span.Name(), span.SpanKind())
	}
	if span.SpanContext().TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" || span.Parent().SpanID().String() != "00f067aa0ba902b7" {
		t.Fatal("incoming traceparent was not continued")
	}
	for key, want := range map[string]string{
		"http.request.method":       "GET",
		"http.route":                "/api/v1/orders/{id}",
		"http.response.status_code": "200",
		"url.scheme":                "http",
		"network.protocol.version":  "1.1",
	} {
		if got := spanAttr(span, key); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
	if span.Status().Code == codes.Error {
		t.Fatal("200 marked as an error")
	}

	// Nothing from the URL, query string or headers is recorded.
	var recorded strings.Builder
	fmt.Fprint(&recorded, span.Name())
	for _, kv := range span.Attributes() {
		fmt.Fprint(&recorded, kv.Key, kv.Value.Emit())
	}
	for _, point := range h.durations(t) {
		for _, kv := range point.Attributes.ToSlice() {
			fmt.Fprint(&recorded, kv.Key, kv.Value.Emit())
		}
	}
	recorded.WriteString(h.logs.String())
	for _, forbidden := range []string{"secret-123", "private", "token", "Bearer"} {
		if strings.Contains(recorded.String(), forbidden) {
			t.Fatalf("%q recorded: %s", forbidden, recorded.String())
		}
	}

	var line map[string]any
	if err := json.Unmarshal(h.logs.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line["trace_id"] != span.SpanContext().TraceID().String() || line["span_id"] != span.SpanContext().SpanID().String() {
		t.Fatalf("request log not linked to its span: %v", line)
	}
	if len(line["request_id"].(string)) != 32 {
		t.Fatal("request_id missing")
	}
}

func TestDurationLabels(t *testing.T) {
	h := newHarness(t)
	h.do(httptest.NewRequest(http.MethodGet, "/api/v1/orders/1", nil))
	h.do(httptest.NewRequest(http.MethodGet, "/api/v1/orders/2", nil))
	h.do(httptest.NewRequest(http.MethodPost, "/api/v1/fail", nil))

	points := h.durations(t)
	if len(points) != 2 {
		t.Fatalf("%d series, want 2", len(points))
	}
	for _, point := range points {
		set := point.Attributes
		route, class := value(set, "http.route"), value(set, "http.response.status_class")
		switch {
		case route == "/api/v1/orders/{id}" && class == "2xx" && value(set, "http.request.method") == "GET":
			if point.Count != 2 {
				t.Fatalf("orders count %d, want 2", point.Count)
			}
		case route == "/api/v1/fail" && class == "5xx" && value(set, "http.request.method") == "POST":
		default:
			t.Fatalf("unexpected series %v", set.ToSlice())
		}
		if set.Len() != 3 {
			t.Fatalf("labels %v, want method, route and status class only", set.ToSlice())
		}
	}
}

// Every unknown path, SPA route and method collapses into fixed label values.
func TestUnknownPathsAddNoSeries(t *testing.T) {
	h := newHarness(t)
	for i := range 50 {
		h.do(httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/unknown-%d", i), nil))
		h.do(httptest.NewRequest(http.MethodGet, fmt.Sprintf("/account/orders/%d", i), nil))
		h.do(httptest.NewRequest(http.MethodGet, fmt.Sprintf("/assets/missing-%d.js", i), nil))
		h.do(httptest.NewRequest(fmt.Sprintf("VERB%d", i), fmt.Sprintf("/api/v1/orders/%d", i), nil))
		h.do(httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/orders/%d", i), nil))
		h.do(httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/orders/%d/", i), nil))
	}
	want := map[string]bool{
		"GET unmatched 4xx":    true, // unknown API path and trailing slash
		"GET static 2xx":       true, // SPA route
		"GET static 4xx":       true, // missing asset
		"_OTHER unmatched 4xx": true, // unknown method
		"POST unmatched 4xx":   true, // 405
	}
	points := h.durations(t)
	for _, point := range points {
		set := point.Attributes
		key := value(set, "http.request.method") + " " + value(set, "http.route") + " " + value(set, "http.response.status_class")
		if !want[key] {
			t.Fatalf("unexpected series %q", key)
		}
	}
	if len(points) != len(want) {
		t.Fatalf("%d series, want %d", len(points), len(want))
	}
	for _, span := range h.spans.Ended() {
		if name := span.Name(); name != "GET unmatched" && name != "GET static" && name != "_OTHER unmatched" && name != "POST unmatched" {
			t.Fatalf("span name %q", name)
		}
	}
}

func TestHealthAndMetricsAreNotTraced(t *testing.T) {
	h := newHarness(t)
	for _, path := range []string{"/health/live", "/health/ready", "/health/unknown", "/metrics"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
		h.do(r)
	}
	if len(h.spans.Ended()) != 0 || len(h.durations(t)) != 0 {
		t.Fatal("health or metrics requests were traced")
	}
	if strings.Count(h.logs.String(), `"msg":"http request"`) != 4 || strings.Contains(h.logs.String(), "trace_id") {
		t.Fatalf("health logs changed: %s", h.logs.String())
	}
}

func TestErrorsAndPanics(t *testing.T) {
	h := newHarness(t)
	h.do(httptest.NewRequest(http.MethodPost, "/api/v1/fail", nil))
	h.do(httptest.NewRequest(http.MethodGet, "/api/v1/panic", nil))

	ended := h.spans.Ended()
	if len(ended) != 2 {
		t.Fatalf("%d spans, want 2", len(ended))
	}
	if ended[0].Status().Code != codes.Error || spanAttr(ended[0], "error.type") != "500" {
		t.Fatal("500 not marked as an error")
	}
	if ended[1].Name() != "GET /api/v1/panic" || ended[1].Status().Code != codes.Error || spanAttr(ended[1], "error.type") != "panic" || spanAttr(ended[1], "http.response.status_code") != "500" {
		t.Fatalf("panic span: %s %v", ended[1].Name(), ended[1].Attributes())
	}
	if strings.Contains(fmt.Sprint(ended[1].Status(), ended[1].Events()), "private") {
		t.Fatal("panic value recorded")
	}
	if !strings.Contains(h.logs.String(), `"msg":"request panic"`) || strings.Count(h.logs.String(), `"trace_id"`) != 3 {
		t.Fatalf("panic logs not linked: %s", h.logs.String())
	}
}

// A request whose client went away is recorded as 499, not as a server error.
func TestClientClosedIsNotAServerError(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h.do(httptest.NewRequest(http.MethodGet, "/api/v1/slow", nil).WithContext(ctx))

	span := h.spans.Ended()[0]
	if span.Status().Code == codes.Error || spanAttr(span, "http.response.status_code") != "499" {
		t.Fatalf("client-closed span: %v %v", span.Status(), span.Attributes())
	}
	for _, point := range h.durations(t) {
		if set := point.Attributes; value(set, "http.response.status_class") != "4xx" {
			t.Fatalf("client-closed class %v", set.ToSlice())
		}
	}
}

// With telemetry off, an incoming traceparent changes nothing in the logs.
func TestOffLeavesLogsUnchanged(t *testing.T) {
	var logs bytes.Buffer
	server := New("127.0.0.1:0", func(context.Context) error { return nil }, slog.New(telemetry.LogHandler(slog.NewJSONHandler(&logs, nil))), testRoutes)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/orders/1", nil)
	r.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	server.Handler.ServeHTTP(httptest.NewRecorder(), r)

	var line map[string]any
	if err := json.Unmarshal(logs.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	delete(line, "time")
	delete(line, "request_id")
	delete(line, "duration_ms")
	if fmt.Sprint(line) != fmt.Sprint(map[string]any{"level": "INFO", "msg": "http request", "method": "GET", "status": float64(200)}) {
		t.Fatalf("log line changed with telemetry off: %v", line)
	}
}

func TestMethodAndStatusBounds(t *testing.T) {
	for method, want := range map[string]string{"GET": "GET", "PATCH": "PATCH", "get": "_OTHER", "PROPFIND": "_OTHER"} {
		if got := methodLabel(method); got != want {
			t.Fatalf("methodLabel(%q) = %q", method, got)
		}
	}
	for status, want := range map[int]string{200: "2xx", 304: "3xx", 499: "4xx", 503: "5xx", 0: "other", 600: "other"} {
		if got := statusClass(status); got != want {
			t.Fatalf("statusClass(%d) = %q", status, got)
		}
	}
}

// The names scrapers see on METRICS_ADDR, after Prometheus translation.
func TestPrometheusNames(t *testing.T) {
	tel, err := telemetry.Start(context.Background(), telemetry.Settings{MetricsAddress: "127.0.0.1:0", Getenv: func(string) string { return "" }})
	if err != nil {
		t.Fatal(err)
	}
	defer tel.Shutdown(context.Background())
	server, err := NewInstrumented("127.0.0.1:0", nil, slog.New(slog.DiscardHandler),
		Instrumentation{TracerProvider: tel.TracerProvider, MeterProvider: tel.MeterProvider, Propagator: tel.Propagator}, testRoutes)
	if err != nil {
		t.Fatal(err)
	}
	server.Handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/orders/1", nil))

	response, err := http.Get("http://" + tel.MetricsAddr().String() + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body bytes.Buffer
	_, _ = body.ReadFrom(response.Body)
	for _, want := range []string{
		`http_server_request_duration_seconds_bucket{http_request_method="GET",http_response_status_class="2xx",http_route="/api/v1/orders/{id}",le="0.005"}`,
		`http_server_request_duration_seconds_count{http_request_method="GET",http_response_status_class="2xx",http_route="/api/v1/orders/{id}"} 1`,
		`http_server_active_requests{http_request_method="GET"} 0`,
	} {
		if !strings.Contains(body.String(), want) {
			t.Fatalf("metrics lack %s:\n%s", want, body.String())
		}
	}
}
