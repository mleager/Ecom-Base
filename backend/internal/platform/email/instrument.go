package email

import (
	"context"
	"strconv"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"

	"ecom/backend/internal/platform/metrics"
)

// scopeName is the instrumentation scope for SMTP spans.
const scopeName = "ecom/backend/internal/platform/email"

// Instrument wraps an enabled sender with a client span and the
// ecom.email.deliveries counter. A disabled sender is returned unchanged:
// with mail off there is no delivery to observe, and callers keep checking
// Enabled. Spans record only the SMTP server and the message count, never
// addresses, subjects or bodies.
func Instrument(sender Sender, c Config, provider trace.TracerProvider, recorder *metrics.Recorder) Sender {
	if !sender.Enabled() {
		return sender
	}
	if provider == nil {
		provider = tracenoop.NewTracerProvider()
	}
	port, _ := strconv.Atoi(c.Port)
	return &instrumented{
		next:    sender,
		tracer:  provider.Tracer(scopeName),
		metrics: recorder,
		attrs:   []attribute.KeyValue{attribute.String("server.address", c.Host), attribute.Int("server.port", port)},
	}
}

type instrumented struct {
	next    Sender
	tracer  trace.Tracer
	metrics *metrics.Recorder
	attrs   []attribute.KeyValue
}

func (s *instrumented) Enabled() bool {
	return s.next.Enabled()
}

func (s *instrumented) Send(ctx context.Context, batch []Message) error {
	ctx, span := s.tracer.Start(ctx, "smtp send",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(s.attrs...),
		trace.WithAttributes(attribute.Int("email.message.count", len(batch))),
	)
	defer span.End()

	err := s.next.Send(ctx, batch)
	if err != nil {
		// The transport reports every failure as ErrDelivery, by design.
		span.SetAttributes(attribute.String("error.type", "delivery_unconfirmed"))
		span.SetStatus(codes.Error, "")
		s.metrics.EmailDelivery(ctx, metrics.EmailFailed)
		return err
	}
	s.metrics.EmailDelivery(ctx, metrics.EmailSent)
	return nil
}
