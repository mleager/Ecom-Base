package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

func noEnv(string) string { return "" }

func envFrom(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func capture() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewJSONHandler(&buf, nil)), &buf
}

func shutdown(t *testing.T, tel *Telemetry) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tel.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

func TestOffByDefault(t *testing.T) {
	logger, logs := capture()
	tel, err := Start(context.Background(), Settings{Logger: logger, Getenv: noEnv})
	if err != nil {
		t.Fatal(err)
	}
	defer shutdown(t, tel)

	if tel.TracesEnabled() || tel.MetricsAddr() != nil {
		t.Fatal("telemetry turned itself on without configuration")
	}
	_, span := tel.TracerProvider.Tracer("test").Start(context.Background(), "request")
	if span.IsRecording() {
		t.Fatal("span recorded with traces off")
	}
	span.End()

	// An incoming traceparent must not reach the context when traces are off,
	// or it would change log content.
	carrier := propagation.MapCarrier{"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}
	if trace.SpanContextFromContext(tel.Propagator.Extract(context.Background(), carrier)).IsValid() {
		t.Fatal("trace context extracted with traces off")
	}
	if logs.Len() != 0 {
		t.Fatalf("logged with telemetry off: %s", logs.String())
	}
}

func TestSettingsSwitches(t *testing.T) {
	cases := []struct {
		name        string
		env         map[string]string
		wantTraces  bool
		wantError   string
		withMetrics bool
	}{
		{"exporter none", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:1", "OTEL_TRACES_EXPORTER": "none"}, false, "", false},
		{"other exporter", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:1", "OTEL_TRACES_EXPORTER": "zipkin"}, false, "OTEL_TRACES_EXPORTER", false},
		{"gRPC protocol", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:1", "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc"}, false, "OTEL_EXPORTER_OTLP_PROTOCOL", false},
		{"gRPC traces protocol", map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://127.0.0.1:1/v1/traces", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "grpc"}, false, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", false},
		{"HTTP protocol", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:1", "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf"}, true, "", false},
		{"traces endpoint only", map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://127.0.0.1:1/v1/traces"}, true, "", false},
		{"SDK disabled", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:1", "OTEL_SDK_DISABLED": "true"}, false, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			settings := Settings{Getenv: envFrom(tc.env)}
			if tc.withMetrics {
				settings.MetricsAddress = "127.0.0.1:0"
			}
			tel, err := Start(context.Background(), settings)
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("Start error = %v, want one naming %s", err, tc.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer shutdown(t, tel)
			if tel.TracesEnabled() != tc.wantTraces {
				t.Fatalf("TracesEnabled = %v, want %v", tel.TracesEnabled(), tc.wantTraces)
			}
			if tc.withMetrics && tel.MetricsAddr() != nil {
				t.Fatal("OTEL_SDK_DISABLED left the metrics listener on")
			}
		})
	}
}

// otlpCollector is a minimal OTLP/HTTP receiver that keeps decoded requests.
type otlpCollector struct {
	mu       sync.Mutex
	requests []*coltracepb.ExportTraceServiceRequest
	types    []string
}

func (c *otlpCollector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var request coltracepb.ExportTraceServiceRequest
	if r.URL.Path != "/v1/traces" || proto.Unmarshal(body, &request) != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	c.mu.Lock()
	c.requests = append(c.requests, &request)
	c.types = append(c.types, r.Header.Get("Content-Type"))
	c.mu.Unlock()
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(http.StatusOK)
}

func TestTracesExportOverOTLPHTTP(t *testing.T) {
	collector := &otlpCollector{}
	server := httptest.NewServer(collector)
	defer server.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", server.URL)

	logger, logs := capture()
	tel, err := Start(context.Background(), Settings{Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	if !tel.TracesEnabled() || !strings.Contains(logs.String(), `"msg":"telemetry configured"`) || !strings.Contains(logs.String(), `"traces":true`) {
		t.Fatalf("traces not reported as enabled: %s", logs.String())
	}
	_, span := tel.TracerProvider.Tracer("test").Start(context.Background(), "checkout")
	span.End()
	shutdown(t, tel) // Shutdown flushes the batch.

	collector.mu.Lock()
	defer collector.mu.Unlock()
	if len(collector.requests) == 0 {
		t.Fatal("no OTLP request received")
	}
	if collector.types[0] != "application/x-protobuf" {
		t.Fatalf("content type %q", collector.types[0])
	}
	resourceSpans := collector.requests[0].GetResourceSpans()
	var service, name string
	for _, attr := range resourceSpans[0].GetResource().GetAttributes() {
		if attr.GetKey() == "service.name" {
			service = attr.GetValue().GetStringValue()
		}
	}
	name = resourceSpans[0].GetScopeSpans()[0].GetSpans()[0].GetName()
	if service != DefaultServiceName || name != "checkout" {
		t.Fatalf("service %q span %q", service, name)
	}
}

func TestServiceNameFromEnvironment(t *testing.T) {
	collector := &otlpCollector{}
	server := httptest.NewServer(collector)
	defer server.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", server.URL)
	t.Setenv("OTEL_SERVICE_NAME", "ecom-api-canary")

	tel, err := Start(context.Background(), Settings{})
	if err != nil {
		t.Fatal(err)
	}
	_, span := tel.TracerProvider.Tracer("test").Start(context.Background(), "request")
	span.End()
	shutdown(t, tel)

	collector.mu.Lock()
	defer collector.mu.Unlock()
	if len(collector.requests) == 0 {
		t.Fatal("no OTLP request received")
	}
	for _, attr := range collector.requests[0].GetResourceSpans()[0].GetResource().GetAttributes() {
		if attr.GetKey() == "service.name" && attr.GetValue().GetStringValue() == "ecom-api-canary" {
			return
		}
	}
	t.Fatal("OTEL_SERVICE_NAME did not override the default")
}

// A collector that accepts connections but never answers must not slow
// span creation, and shutdown must still end at its deadline.
func TestUnreachableEndpointNeverDelaysRequests(t *testing.T) {
	release := make(chan struct{})
	reached := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case reached <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)

	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", server.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_TIMEOUT", "60000")
	t.Setenv("OTEL_BSP_SCHEDULE_DELAY", "1")
	t.Setenv("OTEL_BSP_MAX_QUEUE_SIZE", "8")
	t.Setenv("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", "4")

	tel, err := Start(context.Background(), Settings{})
	if err != nil {
		t.Fatal(err)
	}
	tracer := tel.TracerProvider.Tracer("test")

	// Fill the queue so later spans have to be dropped, not waited for.
	start := time.Now()
	for range 2000 {
		_, span := tracer.Start(context.Background(), "request")
		span.End()
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("2000 spans took %v while the collector hung", elapsed)
	}
	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("the exporter never contacted the hanging collector")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start = time.Now()
	_ = tel.Shutdown(ctx) // A deadline error is expected; the bound is what matters.
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("Shutdown took %v past its 300ms deadline", elapsed)
	}
}

func get(t *testing.T, method, url string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(body)
}

func TestMetricsListener(t *testing.T) {
	logger, logs := capture()
	tel, err := Start(context.Background(), Settings{MetricsAddress: "127.0.0.1:0", Logger: logger, Getenv: noEnv})
	if err != nil {
		t.Fatal(err)
	}
	if tel.MetricsAddr() == nil || tel.TracesEnabled() {
		t.Fatal("expected metrics on and traces off")
	}
	var line struct {
		Msg            string `json:"msg"`
		MetricsAddress string `json:"metrics_address"`
	}
	if json.Unmarshal(logs.Bytes(), &line) != nil || line.Msg != "telemetry configured" || line.MetricsAddress != tel.MetricsAddr().String() {
		t.Fatalf("startup line: %s", logs.String())
	}

	counter, err := tel.MeterProvider.Meter("test").Int64Counter("ecom.test.requests")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(context.Background(), 2)

	base := "http://" + tel.MetricsAddr().String()
	status, body := get(t, http.MethodGet, base+"/metrics")
	if status != http.StatusOK {
		t.Fatalf("GET /metrics = %d", status)
	}
	for _, want := range []string{"go_goroutines ", "process_cpu_seconds_total ", "ecom_test_requests_total 2", `service_name="ecom-api"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics output lacks %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "otel_scope_name") {
		t.Fatal("scope labels should be off")
	}
	if status, _ := get(t, http.MethodHead, base+"/metrics"); status != http.StatusOK {
		t.Fatalf("HEAD /metrics = %d", status)
	}
	if status, _ := get(t, http.MethodPost, base+"/metrics"); status != http.StatusMethodNotAllowed {
		t.Fatalf("POST /metrics = %d", status)
	}
	if status, _ := get(t, http.MethodGet, base+"/api/v1/products"); status != http.StatusNotFound {
		t.Fatalf("other path = %d", status)
	}

	shutdown(t, tel)
	if conn, err := net.DialTimeout("tcp", tel.MetricsAddr().String(), time.Second); err == nil {
		conn.Close()
		t.Fatal("metrics listener still accepts connections after Shutdown")
	}
	if err := tel.Shutdown(context.Background()); err != nil {
		t.Fatalf("second Shutdown: %v", err)
	}
}

func TestMetricsAddressInUse(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	_, err = Start(context.Background(), Settings{MetricsAddress: busy.Addr().String(), Getenv: noEnv})
	if err == nil || !strings.Contains(err.Error(), "METRICS_ADDR") {
		t.Fatalf("Start error = %v, want a METRICS_ADDR error", err)
	}
}

func TestExportErrorsAreRateLimited(t *testing.T) {
	logger, logs := capture()
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	handler := newExportErrorLogger(logger, func() time.Time { return now })
	failure := errors.New("connection refused")

	handler.Handle(failure)
	handler.Handle(failure)
	handler.Handle(failure)
	if got := strings.Count(logs.String(), "telemetry export failed"); got != 1 {
		t.Fatalf("logged %d times within the interval, want 1", got)
	}
	now = now.Add(exportErrorInterval)
	handler.Handle(failure)
	if got := strings.Count(logs.String(), "telemetry export failed"); got != 2 {
		t.Fatalf("logged %d times after the interval, want 2", got)
	}
	if !strings.Contains(logs.String(), `"suppressed":2`) {
		t.Fatalf("suppressed count missing: %s", logs.String())
	}
}
