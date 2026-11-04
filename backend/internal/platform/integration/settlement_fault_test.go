//go:build integration

package integration

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"ecom/backend/internal/checkout"
)

func TestOrderHTTPCommitUncertainty(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mode   commitFaultMode
		target int32
		status int
		calls  int32
	}{
		{"claim lost acknowledgement", commitDropAfter, 2, 202, 0},
		{"claim rolled back", commitDropBefore, 2, 202, 0},
		{"T2 lost acknowledgement", commitDropAfter, 3, 201, 1},
		{"T2 rolled back", commitDropBefore, 3, 202, 1},
		{"T2 still in flight", commitDelayed, 3, 503, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 5, 100)
			customer := seedCheckoutCustomer(t, f, checkoutLine{product, 2})
			pool, fault := newCommitFaultPool(t, f, tc.mode)
			fault.target = tc.target
			var calls atomic.Int32
			api := newPaymentAPI(t, f, pool, simulatorFunc(func(ctx context.Context, attempt checkout.Attempt) (checkout.Decision, error) {
				calls.Add(1)
				return (checkout.LocalSimulator{}).Evaluate(ctx, attempt)
			}))
			token := checkoutBearer(t, f, customer.user, api.secret)
			body := requestJSON(t, customer.request)
			response := orderRequest(t, api.api, "POST", "/api/v1/checkout", body, token, []string{"wire-fault"}, tc.status)
			if !fault.used.Load() || calls.Load() != tc.calls {
				t.Fatalf("fault=%v simulator calls=%d want=%d", fault.used.Load(), calls.Load(), tc.calls)
			}
			if tc.mode == commitDelayed {
				if !strings.Contains(string(response.body), `"code":"checkout_outcome_uncertain"`) {
					t.Fatal("in-flight T2 was not reported as uncertain")
				}
				// T2 is still holding its locks. No stale T1 response may claim 202.
				fault.once.Do(func() { close(fault.release) })
			}
			awaitCommitFault(t, fault)
			replay := decodeResponse[checkout.Order](t, orderRequest(t, api.api, "POST", "/api/v1/checkout", body, token, []string{"wire-fault"}, 200))
			if calls.Load() != tc.calls {
				t.Fatal("same-key retry resumed processing")
			}
			switch {
			case tc.target == 3 && tc.mode != commitDropBefore:
				if replay.Status != "confirmed" {
					t.Fatal("committed T2 outcome not retained")
				}
				assertStock(t, f, product, 3, 0)
				assertOrderState(t, f, replay.ID, "confirmed", "succeeded", "consumed", 2)
			case tc.target == 2 && tc.mode == commitDropBefore:
				assertOrderState(t, f, replay.ID, "pending_payment", "pending", "active", 1)
				if _, err := checkout.NewService(f.pool).Cancel(f.ctx, customer.user, replay.ID); err != nil {
					t.Fatal(err)
				}
				assertStock(t, f, product, 5, 0)
			default:
				assertOrderState(t, f, replay.ID, "pending_payment", "processing", "active", 1)
				assertStock(t, f, product, 5, 2)
				// Explicit internal finalization, never a side effect of GET or replay.
				if _, err := checkout.NewService(f.pool).Settle(f.ctx, customer.user, replay.ID, replay.Payment.ID, checkout.Accepted); err != nil {
					t.Fatal(err)
				}
				assertStock(t, f, product, 3, 0)
				assertOrderState(t, f, replay.ID, "confirmed", "succeeded", "consumed", 2)
			}
			assertCheckoutIntegrity(t, f)
		})
	}

	for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter, commitDelayed} {
		name := map[commitFaultMode]string{commitDropBefore: "before", commitDropAfter: "after", commitDelayed: "in flight"}[mode]
		t.Run("cancellation "+name, func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 5, 100)
			customer, pending := pendingOrder(t, f, "accept", checkoutLine{product, 2})
			pool, fault := newCommitFaultPool(t, f, mode)
			api := newPaymentAPI(t, f, pool, nil)
			token := checkoutBearer(t, f, customer.user, api.secret)
			status := 503
			if mode == commitDropAfter {
				status = 200
			}
			path := "/api/v1/orders/" + pending.ID + "/cancel"
			response := orderRequest(t, api.api, "POST", path, "", token, nil, status)
			if status == 503 && !strings.Contains(string(response.body), `"code":"order_outcome_uncertain"`) {
				t.Fatal("uncertain cancellation error contract mismatch")
			}
			fault.once.Do(func() { close(fault.release) })
			awaitCommitFault(t, fault)
			order := decodeResponse[checkout.Order](t, orderRequest(t, api.api, "POST", path, "", token, nil, 200))
			if order.ID != pending.ID || order.Status != "cancelled" {
				t.Fatal("cancellation retry did not retain the same order")
			}
			assertStock(t, f, product, 5, 0)
			assertOrderState(t, f, pending.ID, "cancelled", "cancelled", "released", 2)
		})
	}
}

func TestSettlementIntegrity(t *testing.T) {
	for _, statement := range []string{
		`UPDATE inventory_reservations SET quantity=quantity+1`,
		`UPDATE inventory SET quantity_reserved=quantity_reserved+1`,
		`UPDATE payment_attempts SET simulator_reference='wrong-attempt-reference'`,
		`UPDATE orders SET subtotal_cents=subtotal_cents+1,total_cents=total_cents+1`,
	} {
		t.Run(statement, func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 5, 100)
			customer, pending := pendingOrder(t, f, "accept", checkoutLine{product, 1})
			if _, err := f.migrator.Exec(f.ctx, statement); err != nil {
				t.Fatal(err)
			}
			service := checkout.NewService(f.pool)
			if _, err := service.Claim(f.ctx, customer.user, pending.ID); !errors.Is(err, checkout.ErrIntegrity) {
				t.Fatalf("claim accepted corrupt graph: %v", err)
			}
			if _, err := service.Cancel(f.ctx, customer.user, pending.ID); !errors.Is(err, checkout.ErrIntegrity) {
				t.Fatalf("cancellation repaired corrupt graph: %v", err)
			}
			api := newPaymentAPI(t, f, f.pool, nil)
			token := checkoutBearer(t, f, customer.user, api.secret)
			response := orderRequest(t, api.api, "POST", "/api/v1/orders/"+pending.ID+"/cancel", "", token, nil, 500)
			if !strings.Contains(string(response.body), `"code":"internal_error"`) || strings.Contains(string(response.body), "UPDATE") || !strings.Contains(api.logs.String(), "order integrity failure") {
				t.Fatal("integrity failure was not safely reported")
			}
			var state, payment string
			var history int
			if err := f.migrator.QueryRow(f.ctx, `SELECT o.status,p.status,(SELECT count(*) FROM order_status_history WHERE order_id=o.id) FROM orders o JOIN payment_attempts p ON p.order_id=o.id WHERE o.id=$1`, pending.ID).Scan(&state, &payment, &history); err != nil || state != "pending_payment" || payment != "pending" || history != 1 {
				t.Fatalf("integrity failure mutated state: %s/%s history=%d err=%v", state, payment, history, err)
			}
		})
	}
	t.Run("terminal retry validates reservation state", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		customer, pending := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		service := checkout.NewService(f.pool)
		if _, err := service.Process(f.ctx, customer.user, pending.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory_reservations SET status='released'`); err != nil {
			t.Fatal(err)
		}
		if _, err := service.Settle(f.ctx, customer.user, pending.ID, pending.Payment.ID, checkout.Accepted); !errors.Is(err, checkout.ErrIntegrity) {
			t.Fatalf("inconsistent terminal state accepted as no-op: %v", err)
		}
		assertStock(t, f, product, 4, 0)
	})
}
