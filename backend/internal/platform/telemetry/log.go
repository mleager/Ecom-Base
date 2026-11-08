package telemetry

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

// LogHandler adds trace_id and span_id to records logged with a context that
// holds a valid span. Without one (tracing off, or no span) records pass
// through unchanged, so log content stays the same when telemetry is off.
func LogHandler(next slog.Handler) slog.Handler {
	return logHandler{next}
}

type logHandler struct {
	next slog.Handler
}

func (h logHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h logHandler) Handle(ctx context.Context, record slog.Record) error {
	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		record = record.Clone()
		record.AddAttrs(
			slog.String("trace_id", span.TraceID().String()),
			slog.String("span_id", span.SpanID().String()),
		)
	}
	return h.next.Handle(ctx, record)
}

func (h logHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return logHandler{h.next.WithAttrs(attrs)}
}

func (h logHandler) WithGroup(name string) slog.Handler {
	return logHandler{h.next.WithGroup(name)}
}
