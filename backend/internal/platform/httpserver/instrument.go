package httpserver

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

// Route label values for requests without a matched route pattern. Every
// other value is a chi route pattern, so the label set is fixed by the code.
const (
	// RouteStatic covers every response from the SPA fallback (STATIC_DIR).
	RouteStatic = "static"
	// RouteUnmatched covers unknown paths and methods (404 and 405).
	RouteUnmatched = "unmatched"
)

// scopeName is the instrumentation scope for HTTP spans and metrics.
const scopeName = "ecom/backend/internal/platform/httpserver"

// durationBuckets are the OpenTelemetry semantic-convention boundaries for
// http.server.request.duration, in seconds.
var durationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10}

// Instrumentation carries the OpenTelemetry providers for HTTP server spans
// and request metrics. Nil fields record nothing.
type Instrumentation struct {
	TracerProvider trace.TracerProvider
	MeterProvider  metric.MeterProvider
	// Propagator extracts incoming W3C trace context. Leave it empty when
	// traces are off, so a client cannot inject IDs into the logs.
	Propagator propagation.TextMapPropagator
}

type instruments struct {
	tracer     trace.Tracer
	propagator propagation.TextMapPropagator
	duration   metric.Float64Histogram
	active     metric.Int64UpDownCounter
}

func newInstruments(i Instrumentation) (*instruments, error) {
	if i.TracerProvider == nil {
		i.TracerProvider = tracenoop.NewTracerProvider()
	}
	if i.MeterProvider == nil {
		i.MeterProvider = metricnoop.NewMeterProvider()
	}
	if i.Propagator == nil {
		i.Propagator = propagation.NewCompositeTextMapPropagator()
	}

	meter := i.MeterProvider.Meter(scopeName)
	duration, err := meter.Float64Histogram("http.server.request.duration",
		metric.WithUnit("s"),
		metric.WithDescription("Duration of HTTP server requests."),
		metric.WithExplicitBucketBoundaries(durationBuckets...),
	)
	if err != nil {
		return nil, err
	}

	active, err := meter.Int64UpDownCounter("http.server.active_requests",
		metric.WithUnit("{request}"),
		metric.WithDescription("Number of HTTP server requests in progress."),
	)
	if err != nil {
		return nil, err
	}

	return &instruments{
		tracer:     i.TracerProvider.Tracer(scopeName),
		propagator: i.Propagator,
		duration:   duration,
		active:     active,
	}, nil
}

// traced reports whether a path gets spans and metrics. Health probes and
// the admin metrics route are frequent and carry no user traffic.
func traced(p string) bool {
	return !(p == "/health" || strings.HasPrefix(p, "/health/") ||
		p == "/metrics" || strings.HasPrefix(p, "/metrics/"))
}

// methodLabel bounds the method attribute: clients can send any token.
func methodLabel(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodOptions, http.MethodConnect, http.MethodTrace:
		return method
	}
	return "_OTHER"
}

func statusClass(status int) string {
	if status < 100 || status > 599 {
		return "other"
	}
	return strconv.Itoa(status/100) + "xx"
}

type routeKey struct{}

// routeOverride lets a fallback handler name its response after routing.
type routeOverride struct {
	value string
}

// markStatic labels the request as served by the SPA fallback.
func markStatic(r *http.Request) {
	if override, ok := r.Context().Value(routeKey{}).(*routeOverride); ok {
		override.value = RouteStatic
	}
}

// routeOf returns the matched chi route pattern. chi reports a mount's "/*"
// pattern when nothing inside the mount matched, so that counts as unmatched.
func routeOf(r *http.Request, override *routeOverride) string {
	if override.value != "" {
		return override.value
	}
	if rc := chi.RouteContext(r.Context()); rc != nil {
		if pattern := rc.RoutePattern(); pattern != "" && !strings.HasSuffix(pattern, "/*") {
			return pattern
		}
	}
	return RouteUnmatched
}

// requestSpan tracks one traced request.
type requestSpan struct {
	in       *instruments
	span     trace.Span
	override *routeOverride
	method   string
}

// start begins the server span and counts the request as active. It returns
// the request to pass on, carrying the span and the route override.
func (in *instruments) start(r *http.Request) (*http.Request, *requestSpan) {
	method := methodLabel(r.Method)
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	version := "1.1"

	switch {
	case r.ProtoMajor == 2:
		version = "2"
	case r.ProtoMajor == 1 && r.ProtoMinor == 0:
		version = "1.0"
	}

	ctx := in.propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
	ctx, span := in.tracer.Start(ctx, method,
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("http.request.method", method),
			attribute.String("url.scheme", scheme),
			attribute.String("network.protocol.version", version),
		),
	)

	override := &routeOverride{}
	ctx = context.WithValue(ctx, routeKey{}, override)
	in.active.Add(ctx, 1, metric.WithAttributes(attribute.String("http.request.method", method)))

	return r.WithContext(ctx), &requestSpan{in: in, span: span, override: override, method: method}
}

// end names the span by route, records the duration and ends the span.
// status is the logged status (499 when the client went away).
func (s *requestSpan) end(r *http.Request, status int, seconds float64, panicked bool) {
	ctx := r.Context()
	route := routeOf(r, s.override)
	s.span.SetName(s.method + " " + route)
	s.span.SetAttributes(
		attribute.String("http.route", route),
		attribute.Int("http.response.status_code", status),
	)

	switch {
	case panicked:
		s.span.SetAttributes(attribute.String("error.type", "panic"))
		s.span.SetStatus(codes.Error, "panic")
	case status >= 500:
		s.span.SetAttributes(attribute.String("error.type", strconv.Itoa(status)))
		s.span.SetStatus(codes.Error, "")
	}
	s.in.duration.Record(ctx, seconds, metric.WithAttributes(
		attribute.String("http.request.method", s.method),
		attribute.String("http.route", route),
		attribute.String("http.response.status_class", statusClass(status)),
	))

	s.in.active.Add(ctx, -1, metric.WithAttributes(attribute.String("http.request.method", s.method)))
	s.span.End()
}
