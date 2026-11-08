package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/trace"
)

func TestLogHandler(t *testing.T) {
	var plain, wrapped bytes.Buffer
	options := &slog.HandlerOptions{ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
		if a.Key == slog.TimeKey {
			return slog.Attr{}
		}
		return a
	}}
	slog.New(slog.NewJSONHandler(&plain, options)).With("a", 1).InfoContext(context.Background(), "line", "b", 2)
	logger := slog.New(LogHandler(slog.NewJSONHandler(&wrapped, options))).With("a", 1)
	logger.InfoContext(context.Background(), "line", "b", 2)
	if plain.String() != wrapped.String() {
		t.Fatalf("output changed without a span:\n%s%s", plain.String(), wrapped.String())
	}

	traceID, _ := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	spanID, _ := trace.SpanIDFromHex("00f067aa0ba902b7")
	ctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled}))
	wrapped.Reset()
	logger.WithGroup("g").WarnContext(ctx, "linked", "c", 3)
	var line map[string]any
	if err := json.Unmarshal(wrapped.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	group, _ := line["g"].(map[string]any)
	if line["a"] != float64(1) || group["c"] != float64(3) || group["trace_id"] != traceID.String() || group["span_id"] != spanID.String() {
		t.Fatalf("linked line: %s", wrapped.String())
	}

	wrapped.Reset()
	logger.Info("no context")
	if strings.Contains(wrapped.String(), "trace_id") {
		t.Fatal("trace_id without a span")
	}
}
