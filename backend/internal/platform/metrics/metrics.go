// Package metrics records the business counters the scenario projects alert
// on. It depends only on the OpenTelemetry metrics API. A nil *Recorder
// records nothing, so tests and the CLIs need no setup.
//
// Every label value is a constant from this package or a limiter name fixed
// in code: never a user, product, order or session ID.
package metrics

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// scopeName is the instrumentation scope for the business counters.
const scopeName = "ecom/backend/internal/platform/metrics"

// Customer types for checkout counters.
const (
	CustomerAccount = "account"
	CustomerGuest   = "guest"
)

// Payment results.
const (
	PaymentAccepted = "accepted"
	PaymentRejected = "rejected"
)

// Reasons a checkout response leaves the outcome unknown to the client.
const (
	// OutcomeUncertain is a 503 checkout_outcome_uncertain: the order may or
	// may not exist; the client must retry the identical request.
	OutcomeUncertain = "uncertain"
	// OutcomeInterrupted is a 202: the order exists but payment processing
	// stopped before settlement and needs a retry or operator recovery.
	OutcomeInterrupted = "interrupted"
)

// Rate-limit rejection reasons.
const (
	// LimitThrottled means one key used up its allowance.
	LimitThrottled = "throttled"
	// LimitCapacity means the limiter tracks too many keys to admit a new one.
	LimitCapacity = "capacity"
)

// Email delivery results.
const (
	EmailSent   = "sent"
	EmailFailed = "failed"
)

// Recorder holds the business counters.
type Recorder struct {
	orders        metric.Int64Counter
	payments      metric.Int64Counter
	unknown       metric.Int64Counter
	guestSessions metric.Int64Counter
	rateLimited   metric.Int64Counter
	email         metric.Int64Counter
}

// New creates the counters and starts each fixed series at zero, so alert
// queries see a series before the first event.
func New(provider metric.MeterProvider) (*Recorder, error) {
	meter := provider.Meter(scopeName)
	r := &Recorder{}
	for _, c := range []struct {
		target      *metric.Int64Counter
		name, unit  string
		description string
	}{
		{&r.orders, "ecom.orders.created", "{order}", "Orders created by checkout (T1 committed), by customer type."},
		{&r.payments, "ecom.payment.results", "{payment}", "Simulated payment results settled during checkout."},
		{&r.unknown, "ecom.checkout.unknown_outcomes", "{checkout}", "Checkout responses whose final outcome the client could not be told."},
		{&r.guestSessions, "ecom.guest.sessions.created", "{session}", "Guest sessions created."},
		{&r.rateLimited, "ecom.rate_limit.rejections", "{request}", "Requests rejected by an in-process rate limiter."},
		{&r.email, "ecom.email.deliveries", "{delivery}", "SMTP delivery attempts by result."},
	} {
		counter, err := meter.Int64Counter(c.name, metric.WithUnit(c.unit), metric.WithDescription(c.description))
		if err != nil {
			return nil, err
		}
		*c.target = counter
	}

	ctx := context.Background()
	for _, customer := range []string{CustomerAccount, CustomerGuest} {
		r.orders.Add(ctx, 0, customerAttr(customer))
		for _, reason := range []string{OutcomeUncertain, OutcomeInterrupted} {
			r.unknown.Add(ctx, 0, metric.WithAttributes(attribute.String("customer.type", customer), attribute.String("outcome.reason", reason)))
		}
	}
	for _, result := range []string{PaymentAccepted, PaymentRejected} {
		r.payments.Add(ctx, 0, metric.WithAttributes(attribute.String("payment.result", result)))
	}
	r.guestSessions.Add(ctx, 0)
	for _, result := range []string{EmailSent, EmailFailed} {
		r.email.Add(ctx, 0, metric.WithAttributes(attribute.String("email.result", result)))
	}
	return r, nil
}

func customerAttr(customer string) metric.AddOption {
	return metric.WithAttributes(attribute.String("customer.type", customer))
}

// OrderCreated counts a newly committed order (not a replay).
func (r *Recorder) OrderCreated(ctx context.Context, customer string) {
	if r != nil {
		r.orders.Add(ctx, 1, customerAttr(customer))
	}
}

// PaymentResult counts a payment settled during checkout.
func (r *Recorder) PaymentResult(ctx context.Context, result string) {
	if r != nil {
		r.payments.Add(ctx, 1, metric.WithAttributes(attribute.String("payment.result", result)))
	}
}

// UnknownOutcome counts a checkout response that left the outcome unknown.
func (r *Recorder) UnknownOutcome(ctx context.Context, customer, reason string) {
	if r != nil {
		r.unknown.Add(ctx, 1, metric.WithAttributes(attribute.String("customer.type", customer), attribute.String("outcome.reason", reason)))
	}
}

// GuestSessionCreated counts a new guest session.
func (r *Recorder) GuestSessionCreated(ctx context.Context) {
	if r != nil {
		r.guestSessions.Add(ctx, 1)
	}
}

// LimiterCreated starts a limiter's series at zero.
func (r *Recorder) LimiterCreated(limiter string) {
	if r != nil {
		for _, reason := range []string{LimitThrottled, LimitCapacity} {
			r.rateLimited.Add(context.Background(), 0, limitAttrs(limiter, reason))
		}
	}
}

// RateLimited counts one rejection by the named limiter.
func (r *Recorder) RateLimited(ctx context.Context, limiter, reason string) {
	if r != nil {
		r.rateLimited.Add(ctx, 1, limitAttrs(limiter, reason))
	}
}

func limitAttrs(limiter, reason string) metric.AddOption {
	return metric.WithAttributes(attribute.String("limiter.name", limiter), attribute.String("limiter.reason", reason))
}

// EmailDelivery counts one SMTP send of a batch by result.
func (r *Recorder) EmailDelivery(ctx context.Context, result string) {
	if r != nil {
		r.email.Add(ctx, 1, metric.WithAttributes(attribute.String("email.result", result)))
	}
}
