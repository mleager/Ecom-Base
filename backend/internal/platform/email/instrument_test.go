package email

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"ecom/backend/internal/platform/metrics/metricstest"
)

type fakeSender struct{ err error }

func (fakeSender) Enabled() bool                           { return true }
func (s fakeSender) Send(context.Context, []Message) error { return s.err }

func TestInstrumentedSend(t *testing.T) {
	recorder, reader, _ := metricstest.New(t)
	spans := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	config := Config{Host: "smtp.example.test", Port: "587"}
	batch := []Message{{To: "person@example.com", Subject: "Reset your password", Body: "private-token-link"}}

	ctx, parent := provider.Tracer("test").Start(context.Background(), "POST /api/v1/auth/password-resets")
	if err := Instrument(fakeSender{}, config, provider, recorder).Send(ctx, batch); err != nil {
		t.Fatal(err)
	}
	if err := Instrument(fakeSender{err: ErrDelivery}, config, provider, recorder).Send(ctx, append(batch, batch[0])); err != ErrDelivery {
		t.Fatalf("error %v, want ErrDelivery unchanged", err)
	}
	parent.End()

	ended := spans.Ended()
	if len(ended) != 3 {
		t.Fatalf("%d spans, want 3", len(ended))
	}
	sent, failed := ended[0], ended[1]
	for _, span := range []sdktrace.ReadOnlySpan{sent, failed} {
		if span.Name() != "smtp send" || span.SpanKind() != trace.SpanKindClient || span.Parent().SpanID() != parent.SpanContext().SpanID() {
			t.Fatalf("span %q kind %v not under the request", span.Name(), span.SpanKind())
		}
	}
	if sent.Status().Code == codes.Error || failed.Status().Code != codes.Error {
		t.Fatal("span status wrong")
	}
	attributes := fmt.Sprint(failed.Attributes())
	for _, want := range []string{"smtp.example.test", "587", "email.message.count", "delivery_unconfirmed"} {
		if !strings.Contains(attributes, want) {
			t.Fatalf("attributes %s lack %s", attributes, want)
		}
	}
	recorded := fmt.Sprint(sent.Attributes(), failed.Attributes(), failed.Events(), metricstest.Counters(t, reader))
	for _, private := range []string{"person@example.com", "Reset your password", "private-token-link"} {
		if strings.Contains(recorded, private) {
			t.Fatalf("%q recorded", private)
		}
	}

	got := metricstest.Counters(t, reader)
	if got["ecom.email.deliveries{email.result=sent}"] != 1 || got["ecom.email.deliveries{email.result=failed}"] != 1 {
		t.Fatalf("deliveries %v", got)
	}
}

func TestInstrumentLeavesDisabledMailAlone(t *testing.T) {
	recorder, reader, _ := metricstest.New(t)
	sender := Instrument(Disabled{}, Config{}, nil, recorder)
	if _, ok := sender.(Disabled); !ok {
		t.Fatal("disabled sender was wrapped")
	}
	_ = sender.Send(context.Background(), nil)
	if got := metricstest.Counters(t, reader)["ecom.email.deliveries{email.result=failed}"]; got != 0 {
		t.Fatal("disabled mail counted as a failure")
	}
}
