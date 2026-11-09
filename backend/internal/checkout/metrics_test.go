package checkout

import (
	"context"
	"errors"
	"testing"

	"ecom/backend/internal/platform/metrics"
	"ecom/backend/internal/platform/metrics/metricstest"
)

// observe maps each checkout response to the counters. The database paths
// that reach it are covered by TestBusinessMetrics (integration).
func TestObserveCountsCheckoutResponses(t *testing.T) {
	recorder, reader, _ := metricstest.New(t)
	s := (&Service{}).UseMetrics(recorder)
	ctx := context.Background()

	s.observe(ctx, metrics.CustomerAccount, Result{Order: Order{Status: "confirmed"}}, nil)
	s.observe(ctx, metrics.CustomerGuest, Result{Order: Order{Status: "payment_failed"}}, nil)
	s.observe(ctx, metrics.CustomerAccount, Result{}, ErrOutcomeUncertain)
	s.observe(ctx, metrics.CustomerGuest, Result{}, errors.Join(errors.New("wrapped"), ErrOutcomeUncertain))
	s.observe(ctx, metrics.CustomerAccount, Result{Order: Order{Status: "pending_payment"}, Interrupted: true}, nil)
	// Replays and ordinary refusals count nothing.
	s.observe(ctx, metrics.CustomerAccount, Result{Order: Order{Status: "confirmed"}, Replayed: true}, nil)
	s.observe(ctx, metrics.CustomerAccount, Result{}, ErrStaleCart)

	got := metricstest.Counters(t, reader)
	for key, want := range map[string]int64{
		"ecom.payment.results{payment.result=accepted}":                                    1,
		"ecom.payment.results{payment.result=rejected}":                                    1,
		"ecom.checkout.unknown_outcomes{customer.type=account,outcome.reason=uncertain}":   1,
		"ecom.checkout.unknown_outcomes{customer.type=guest,outcome.reason=uncertain}":     1,
		"ecom.checkout.unknown_outcomes{customer.type=account,outcome.reason=interrupted}": 1,
		"ecom.orders.created{customer.type=account}":                                       0,
	} {
		if got[key] != want {
			t.Fatalf("%s = %d, want %d", key, got[key], want)
		}
	}
}

func TestGuestLimitersUseCheckoutMetrics(t *testing.T) {
	recorder, reader, _ := metricstest.New(t)
	NewGuestHandler(NewGuestService(NewService(nil).UseMetrics(recorder), nil, ""), nil, false)
	got := metricstest.Counters(t, reader)
	for _, name := range []string{"guest_checkout_prepare", "guest_checkout_mail", "guest_checkout_proof"} {
		if _, ok := got["ecom.rate_limit.rejections{limiter.name="+name+",limiter.reason=throttled}"]; !ok {
			t.Fatalf("limiter %s has no series", name)
		}
	}
}
