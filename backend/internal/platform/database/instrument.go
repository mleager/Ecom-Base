package database

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

// scopeName is the instrumentation scope for query spans and pool metrics.
const scopeName = "ecom/backend/internal/platform/database"

// PoolName labels the pool metrics. The API has one pool.
const PoolName = "main"

// maxQueryText bounds db.query.text. Statements are fixed code constants.
const maxQueryText = 4096

// durationBuckets are the semantic-convention boundaries for database
// durations, in seconds.
var durationBuckets = []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10}

// Instrumentation carries the OpenTelemetry providers for query spans and
// query and pool metrics. A nil provider records nothing.
type Instrumentation struct {
	TracerProvider trace.TracerProvider
	MeterProvider  metric.MeterProvider
}

var (
	systemAttr = attribute.String("db.system.name", "postgresql")
	poolAttr   = attribute.String("db.client.connection.pool.name", PoolName)
)

// tracer implements pgx.QueryTracer and pgxpool.AcquireTracer. The API uses
// no batches, COPY or explicit prepares, so those hooks are not traced.
type tracer struct {
	meter    metric.Meter
	tracer   trace.Tracer
	duration metric.Float64Histogram
	wait     metric.Float64Histogram
	pending  metric.Int64UpDownCounter
}

// pgx calls these methods itself once OpenInstrumented sets the tracer on
// the connection config. pgxpool detects AcquireTracer at runtime, so these
// assertions turn a signature change in a pgx upgrade into a build failure.
var (
	_ pgx.QueryTracer       = (*tracer)(nil)
	_ pgxpool.AcquireTracer = (*tracer)(nil)
)

func newTracer(i Instrumentation) (*tracer, error) {
	if i.TracerProvider == nil {
		i.TracerProvider = tracenoop.NewTracerProvider()
	}
	if i.MeterProvider == nil {
		i.MeterProvider = metricnoop.NewMeterProvider()
	}
	meter := i.MeterProvider.Meter(scopeName)
	duration, err := meter.Float64Histogram("db.client.operation.duration",
		metric.WithUnit("s"),
		metric.WithDescription("Duration of database queries."),
		metric.WithExplicitBucketBoundaries(durationBuckets...),
	)
	if err != nil {
		return nil, err
	}
	wait, err := meter.Float64Histogram("db.client.connection.wait_time",
		metric.WithUnit("s"),
		metric.WithDescription("Time spent acquiring a connection from the pool."),
		metric.WithExplicitBucketBoundaries(durationBuckets...),
	)
	if err != nil {
		return nil, err
	}
	pending, err := meter.Int64UpDownCounter("db.client.connection.pending_requests",
		metric.WithUnit("{request}"),
		metric.WithDescription("Requests currently waiting for a pool connection."),
	)
	if err != nil {
		return nil, err
	}
	return &tracer{meter: meter, tracer: i.TracerProvider.Tracer(scopeName), duration: duration, wait: wait, pending: pending}, nil
}

// observe registers the pool gauges, read from pgxpool.Stat at collection.
func (t *tracer) observe(pool *pgxpool.Pool) error {
	count, err := t.meter.Int64ObservableUpDownCounter("db.client.connection.count",
		metric.WithUnit("{connection}"),
		metric.WithDescription("Pool connections by state: used (acquired) or idle."))
	if err != nil {
		return err
	}
	maximum, err := t.meter.Int64ObservableUpDownCounter("db.client.connection.max",
		metric.WithUnit("{connection}"),
		metric.WithDescription("Maximum pool size (pool_max_conns)."))
	if err != nil {
		return err
	}
	minimum, err := t.meter.Int64ObservableUpDownCounter("db.client.connection.idle.min",
		metric.WithUnit("{connection}"),
		metric.WithDescription("Minimum pool size kept open (pool_min_conns)."))
	if err != nil {
		return err
	}
	timeouts, err := t.meter.Int64ObservableCounter("db.client.connection.timeouts",
		metric.WithUnit("{timeout}"),
		metric.WithDescription("Acquires that ended because their context was cancelled or timed out."))
	if err != nil {
		return err
	}

	minConns := int64(pool.Config().MinConns)
	poolOnly := metric.WithAttributes(poolAttr)
	idle := metric.WithAttributes(poolAttr, attribute.String("db.client.connection.state", "idle"))
	used := metric.WithAttributes(poolAttr, attribute.String("db.client.connection.state", "used"))
	_, err = t.meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		stat := pool.Stat()
		o.ObserveInt64(count, int64(stat.IdleConns()), idle)
		o.ObserveInt64(count, int64(stat.AcquiredConns()), used)
		o.ObserveInt64(maximum, int64(stat.MaxConns()), poolOnly)
		o.ObserveInt64(minimum, minConns, poolOnly)
		o.ObserveInt64(timeouts, stat.CanceledAcquireCount(), poolOnly)
		return nil
	}, count, maximum, minimum, timeouts)
	return err
}

type queryKey struct{}

type queryState struct {
	start     time.Time
	operation string
	span      trace.Span
}

// TraceQueryStart starts a client span only under an existing span, so
// readiness probes and other untraced work create no root spans. The query
// arguments are never read.
func (t *tracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	state := &queryState{start: time.Now(), operation: operationName(data.SQL)}
	if trace.SpanContextFromContext(ctx).IsValid() {
		ctx, state.span = t.tracer.Start(ctx, state.operation,
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(
				systemAttr,
				attribute.String("db.operation.name", state.operation),
				attribute.String("db.query.text", queryText(data.SQL)),
			),
		)
	}
	return context.WithValue(ctx, queryKey{}, state)
}

func (t *tracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	state, ok := ctx.Value(queryKey{}).(*queryState)
	if !ok {
		return
	}
	attrs := []attribute.KeyValue{systemAttr, attribute.String("db.operation.name", state.operation)}
	if data.Err != nil {
		attrs = append(attrs, attribute.String("error.type", errorType(data.Err)))
	}
	t.duration.Record(ctx, time.Since(state.start).Seconds(), metric.WithAttributes(attrs...))
	if state.span != nil {
		if data.Err != nil {
			// Only the code: PostgreSQL messages and details can quote row values.
			state.span.SetAttributes(attribute.String("error.type", errorType(data.Err)))
			state.span.SetStatus(codes.Error, "")
		}
		state.span.End()
	}
}

type acquireKey struct{}

func (t *tracer) TraceAcquireStart(ctx context.Context, _ *pgxpool.Pool, _ pgxpool.TraceAcquireStartData) context.Context {
	t.pending.Add(ctx, 1, metric.WithAttributes(poolAttr))
	return context.WithValue(ctx, acquireKey{}, time.Now())
}

func (t *tracer) TraceAcquireEnd(ctx context.Context, _ *pgxpool.Pool, data pgxpool.TraceAcquireEndData) {
	t.pending.Add(ctx, -1, metric.WithAttributes(poolAttr))
	start, ok := ctx.Value(acquireKey{}).(time.Time)
	if !ok {
		return
	}
	attrs := []attribute.KeyValue{poolAttr}
	if data.Err != nil {
		attrs = append(attrs, attribute.String("error.type", errorType(data.Err)))
	}
	t.wait.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attrs...))
}

// operationName is the sqlc query name ("-- name: GetProduct :one"), or the
// leading SQL keyword from a fixed list. Either way the set is bounded.
func operationName(sql string) string {
	if rest, ok := strings.CutPrefix(sql, "-- name: "); ok {
		name, _, _ := strings.Cut(rest, " ")
		if identifier(name) {
			return name
		}
	}
	trimmed := strings.TrimLeft(sql, " \t\r\n(")
	for strings.HasPrefix(trimmed, "--") { // Skip leading line comments.
		_, trimmed, _ = strings.Cut(trimmed, "\n")
		trimmed = strings.TrimLeft(trimmed, " \t\r\n(")
	}
	end := strings.IndexFunc(trimmed, func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') })
	if end < 0 {
		end = len(trimmed)
	}
	switch keyword := strings.ToUpper(trimmed[:end]); keyword {
	case "SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "VALUES", "BEGIN", "COMMIT", "ROLLBACK",
		"SAVEPOINT", "RELEASE", "SET", "LOCK", "CALL", "DO":
		return keyword
	}
	return "OTHER"
}

func identifier(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return true
}

// queryText drops sqlc's name comment and bounds the length. The text holds
// placeholders ($1), never values: API queries are fixed and parameterized.
func queryText(sql string) string {
	if strings.HasPrefix(sql, "-- name: ") {
		if _, rest, ok := strings.Cut(sql, "\n"); ok {
			sql = rest
		}
	}
	sql = strings.TrimSpace(sql)
	if len(sql) > maxQueryText {
		sql = sql[:maxQueryText]
	}
	return sql
}

// errorType is the SQLSTATE code, or a fixed word for connection and
// context failures. Never the message.
func errorType(err error) string {
	var pgErr *pgconn.PgError
	switch {
	case errors.As(err, &pgErr):
		return pgErr.Code
	// pgconn reports both context errors as timeouts, so check cancellation first.
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded) || pgconn.Timeout(err):
		return "timeout"
	}
	return "other"
}
