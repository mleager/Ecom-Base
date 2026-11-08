// Package telemetry sets up OpenTelemetry tracing and the internal Prometheus
// metrics listener. Both are off unless configured: traces need an OTLP
// endpoint in the standard OTEL_* variables, and metrics need METRICS_ADDR.
// Exporting happens off the request path, so a slow or missing collector
// never delays a request.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otelprometheus "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

// DefaultServiceName is the service.name resource attribute unless
// OTEL_SERVICE_NAME or OTEL_RESOURCE_ATTRIBUTES sets another.
const DefaultServiceName = "ecom-api"

// exportErrorInterval limits how often failed exports are logged.
const exportErrorInterval = time.Minute

// Settings are the process-level choices. Everything else comes from the
// standard OTEL_* variables, which the OpenTelemetry SDK reads itself.
type Settings struct {
	// MetricsAddress is the validated METRICS_ADDR. Empty means no listener.
	MetricsAddress string
	// Logger receives the startup line and rate-limited export failures.
	Logger *slog.Logger
	// Getenv reads the OTEL_* switches. Nil means os.Getenv. The SDK itself
	// always reads the process environment.
	Getenv func(string) string
}

// Telemetry holds the providers the instrumentation uses. With nothing
// configured they are no-ops, so instrumented code needs no special cases.
type Telemetry struct {
	TracerProvider trace.TracerProvider
	MeterProvider  metric.MeterProvider
	// Propagator reads and writes W3C trace context. It is empty when traces
	// are off, so an incoming traceparent never reaches logs or spans.
	Propagator propagation.TextMapPropagator

	tracesEnabled bool
	metricsAddr   net.Addr
	metricsServer *http.Server
	shutdowns     []func(context.Context) error
	once          sync.Once
	shutdownErr   error
}

// TracesEnabled reports whether spans are exported.
func (t *Telemetry) TracesEnabled() bool { return t.tracesEnabled }

// MetricsAddr is the bound metrics listener address, or nil when off.
func (t *Telemetry) MetricsAddr() net.Addr { return t.metricsAddr }

// Start sets up telemetry. It makes no outbound connection: the trace
// exporter connects only when it first sends a batch.
func Start(ctx context.Context, s Settings) (*Telemetry, error) {
	getenv := s.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	logger := s.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

	t := &Telemetry{
		TracerProvider: tracenoop.NewTracerProvider(),
		MeterProvider:  metricnoop.NewMeterProvider(),
		Propagator:     propagation.NewCompositeTextMapPropagator(),
	}

	if strings.EqualFold(strings.TrimSpace(getenv("OTEL_SDK_DISABLED")), "true") {
		return t, nil
	}
	traces, err := tracesConfigured(getenv)
	if err != nil {
		return nil, err
	}
	if !traces && s.MetricsAddress == "" {
		return t, nil
	}

	res, err := newResource(ctx)
	if err != nil {
		return nil, err
	}

	if traces {
		exporter, err := otlptracehttp.New(ctx)
		if err != nil {
			return nil, errors.New("invalid OTLP trace exporter settings")
		}
		provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter), sdktrace.WithResource(res))
		otel.SetErrorHandler(newExportErrorLogger(logger, time.Now))
		t.TracerProvider = provider
		t.Propagator = propagation.TraceContext{}
		t.tracesEnabled = true
		t.shutdowns = append(t.shutdowns, provider.Shutdown)
	}

	if s.MetricsAddress != "" {
		if err := t.startMetrics(s.MetricsAddress, res, logger); err != nil {
			_ = t.Shutdown(ctx)
			return nil, err
		}
	}

	var metricsAddress string
	if t.metricsAddr != nil {
		metricsAddress = t.metricsAddr.String()
	}
	logger.Info("telemetry configured", "traces", t.tracesEnabled, "metrics_address", metricsAddress)
	return t, nil
}

// Shutdown stops the metrics listener and flushes pending spans within ctx.
// It is safe to call more than once.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	t.once.Do(func() {
		var errs []error
		if t.metricsServer != nil {
			errs = append(errs, t.metricsServer.Shutdown(ctx))
		}
		for _, shutdown := range t.shutdowns {
			errs = append(errs, shutdown(ctx))
		}
		t.shutdownErr = errors.Join(errs...)
	})
	return t.shutdownErr
}

// tracesConfigured reports whether an OTLP endpoint is set, and rejects
// settings this build cannot honor rather than silently ignoring them.
func tracesConfigured(getenv func(string) string) (bool, error) {
	switch exporter := strings.TrimSpace(getenv("OTEL_TRACES_EXPORTER")); exporter {
	case "", "otlp":
	case "none":
		return false, nil
	default:
		return false, errors.New("OTEL_TRACES_EXPORTER supports only otlp or none")
	}
	if getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" && getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") == "" {
		return false, nil
	}
	for _, key := range []string{"OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"} {
		if protocol := strings.TrimSpace(getenv(key)); protocol != "" && protocol != "http/protobuf" {
			return false, fmt.Errorf("%s supports only http/protobuf", key)
		}
	}
	return true, nil
}

// newResource names the service. OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
// override the defaults because the environment detector runs last.
func newResource(ctx context.Context) (*resource.Resource, error) {
	attributes := []attribute.KeyValue{attribute.String("service.name", DefaultServiceName)}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		attributes = append(attributes, attribute.String("service.version", info.Main.Version))
	}
	res, err := resource.New(ctx,
		resource.WithAttributes(attributes...),
		resource.WithTelemetrySDK(),
		resource.WithFromEnv(),
	)
	if err != nil {
		return nil, errors.New("invalid OTEL_SERVICE_NAME or OTEL_RESOURCE_ATTRIBUTES")
	}
	return res, nil
}

// startMetrics binds METRICS_ADDR before returning, so a busy port fails
// startup instead of failing silently later.
func (t *Telemetry) startMetrics(address string, res *resource.Resource, logger *slog.Logger) error {
	registry := prometheus.NewRegistry()
	registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	exporter, err := otelprometheus.New(otelprometheus.WithRegisterer(registry), otelprometheus.WithoutScopeInfo())
	if err != nil {
		return errors.New("could not create the Prometheus exporter")
	}
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(exporter), sdkmetric.WithResource(res))
	t.MeterProvider = provider
	t.shutdowns = append(t.shutdowns, provider.Shutdown)

	listener, err := net.Listen("tcp", address)
	if err != nil {
		return errors.New("could not listen on METRICS_ADDR")
	}

	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{
		MaxRequestsInFlight: 4,
		Timeout:             5 * time.Second,
	}))
	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	t.metricsServer = server
	t.metricsAddr = listener.Addr()

	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("metrics listener stopped")
		}
	}()
	return nil
}

// exportErrorLogger logs the first export failure, then at most one summary
// per interval, so an unreachable collector cannot flood the logs.
type exportErrorLogger struct {
	logger *slog.Logger
	now    func() time.Time

	mu         sync.Mutex
	last       time.Time
	suppressed int
}

func newExportErrorLogger(logger *slog.Logger, now func() time.Time) *exportErrorLogger {
	return &exportErrorLogger{logger: logger, now: now}
}

// Handle implements otel.ErrorHandler.
func (l *exportErrorLogger) Handle(err error) {
	l.mu.Lock()
	now := l.now()
	if !l.last.IsZero() && now.Sub(l.last) < exportErrorInterval {
		l.suppressed++
		l.mu.Unlock()
		return
	}
	suppressed := l.suppressed
	l.last, l.suppressed = now, 0
	l.mu.Unlock()

	l.logger.Warn("telemetry export failed", "error", err.Error(), "suppressed", suppressed)
}
