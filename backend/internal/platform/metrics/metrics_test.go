package metrics_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"ecom/backend/internal/platform/metrics"
	"ecom/backend/internal/platform/metrics/metricstest"
	"ecom/backend/internal/platform/telemetry"
)

func TestEachCounterIncrements(t *testing.T) {
	recorder, reader, _ := metricstest.New(t)
	ctx := context.Background()

	// Every fixed series starts at zero.
	zero := metricstest.Counters(t, reader)
	for _, key := range []string{
		"ecom.orders.created{customer.type=account}",
		"ecom.orders.created{customer.type=guest}",
		"ecom.payment.results{payment.result=accepted}",
		"ecom.payment.results{payment.result=rejected}",
		"ecom.checkout.unknown_outcomes{customer.type=account,outcome.reason=uncertain}",
		"ecom.checkout.unknown_outcomes{customer.type=guest,outcome.reason=interrupted}",
		"ecom.guest.sessions.created{}",
		"ecom.email.deliveries{email.result=sent}",
		"ecom.email.deliveries{email.result=failed}",
	} {
		if value, ok := zero[key]; !ok || value != 0 {
			t.Fatalf("%s = %d, present %v; want a zero series", key, value, ok)
		}
	}

	recorder.OrderCreated(ctx, metrics.CustomerGuest)
	recorder.PaymentResult(ctx, metrics.PaymentRejected)
	recorder.UnknownOutcome(ctx, metrics.CustomerAccount, metrics.OutcomeInterrupted)
	recorder.GuestSessionCreated(ctx)
	recorder.LimiterCreated("auth_ip")
	recorder.RateLimited(ctx, "auth_ip", metrics.LimitThrottled)
	recorder.RateLimited(ctx, "auth_ip", metrics.LimitThrottled)
	recorder.EmailDelivery(ctx, metrics.EmailFailed)

	got := metricstest.Counters(t, reader)
	for key, want := range map[string]int64{
		"ecom.orders.created{customer.type=guest}":                                         1,
		"ecom.orders.created{customer.type=account}":                                       0,
		"ecom.payment.results{payment.result=rejected}":                                    1,
		"ecom.checkout.unknown_outcomes{customer.type=account,outcome.reason=interrupted}": 1,
		"ecom.guest.sessions.created{}":                                                    1,
		"ecom.rate_limit.rejections{limiter.name=auth_ip,limiter.reason=throttled}":        2,
		"ecom.rate_limit.rejections{limiter.name=auth_ip,limiter.reason=capacity}":         0,
		"ecom.email.deliveries{email.result=failed}":                                       1,
	} {
		if got[key] != want {
			t.Fatalf("%s = %d, want %d", key, got[key], want)
		}
	}
}

func TestNilRecorderIsSafe(t *testing.T) {
	var recorder *metrics.Recorder
	ctx := context.Background()
	recorder.OrderCreated(ctx, metrics.CustomerAccount)
	recorder.PaymentResult(ctx, metrics.PaymentAccepted)
	recorder.UnknownOutcome(ctx, metrics.CustomerGuest, metrics.OutcomeUncertain)
	recorder.GuestSessionCreated(ctx)
	recorder.LimiterCreated("x")
	recorder.RateLimited(ctx, "x", metrics.LimitCapacity)
	recorder.EmailDelivery(ctx, metrics.EmailSent)
}

// The names scrapers see on METRICS_ADDR.
func TestPrometheusNames(t *testing.T) {
	tel, err := telemetry.Start(context.Background(), telemetry.Settings{MetricsAddress: "127.0.0.1:0", Getenv: func(string) string { return "" }})
	if err != nil {
		t.Fatal(err)
	}
	defer tel.Shutdown(context.Background())
	recorder, err := metrics.New(tel.MeterProvider)
	if err != nil {
		t.Fatal(err)
	}
	recorder.LimiterCreated("guest_bootstrap")
	recorder.OrderCreated(context.Background(), metrics.CustomerAccount)

	response, err := http.Get("http://" + tel.MetricsAddr().String() + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	for _, want := range []string{
		`ecom_orders_created_total{customer_type="account"} 1`,
		`ecom_orders_created_total{customer_type="guest"} 0`,
		`ecom_payment_results_total{payment_result="accepted"} 0`,
		`ecom_checkout_unknown_outcomes_total{customer_type="guest",outcome_reason="uncertain"} 0`,
		`ecom_guest_sessions_created_total 0`,
		`ecom_rate_limit_rejections_total{limiter_name="guest_bootstrap",limiter_reason="throttled"} 0`,
		`ecom_email_deliveries_total{email_result="failed"} 0`,
	} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("metrics lack %s:\n%s", want, body)
		}
	}
}
