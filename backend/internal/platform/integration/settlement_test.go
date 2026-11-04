//go:build integration

package integration

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"ecom/backend/internal/checkout"

	"github.com/jackc/pgx/v5/pgconn"
)

type simulatorFunc func(context.Context, checkout.Attempt) (checkout.Decision, error)

func (fn simulatorFunc) Evaluate(ctx context.Context, attempt checkout.Attempt) (checkout.Decision, error) {
	return fn(ctx, attempt)
}

func pendingOrder(t *testing.T, f *testDatabase, scenario string, lines ...checkoutLine) (checkoutCustomer, checkout.Order) {
	t.Helper()
	customer := seedCheckoutCustomer(t, f, lines...)
	customer.request.PaymentScenario = scenario
	result, err := checkout.NewService(f.pool).CreatePending(f.ctx, customer.user, "key", customer.request)
	if err != nil {
		t.Fatal(err)
	}
	return customer, result.Order
}

func assertOrderState(t *testing.T, f *testDatabase, orderID, orderStatus, paymentStatus, reservationStatus string, history int) {
	t.Helper()
	var status, payment string
	var records, wrong int
	var validTimes bool
	err := f.migrator.QueryRow(f.ctx, `SELECT o.status,p.status,
 (SELECT count(*) FROM order_status_history WHERE order_id=o.id),
 (SELECT count(*) FROM inventory_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=o.id AND r.status<>$2),
 CASE p.status WHEN 'pending' THEN p.started_at IS NULL AND p.completed_at IS NULL
 WHEN 'processing' THEN p.started_at IS NOT NULL AND p.completed_at IS NULL
 WHEN 'cancelled' THEN p.started_at IS NULL AND p.completed_at IS NOT NULL
 ELSE p.started_at IS NOT NULL AND p.completed_at>=p.started_at END
 FROM orders o JOIN payment_attempts p ON p.order_id=o.id WHERE o.id=$1`, orderID, reservationStatus).Scan(&status, &payment, &records, &wrong, &validTimes)
	if err != nil || status != orderStatus || payment != paymentStatus || records != history || wrong != 0 || !validTimes {
		t.Fatalf("order state=%s/%s history=%d mismatched holds=%d timestamps=%v err=%v", status, payment, records, wrong, validTimes, err)
	}
	assertCheckoutIntegrity(t, f)
}

func assertStock(t *testing.T, f *testDatabase, product string, onHand, reserved int) {
	t.Helper()
	var gotOnHand, gotReserved int
	if err := f.migrator.QueryRow(f.ctx, `SELECT quantity_on_hand,quantity_reserved FROM inventory WHERE product_id=$1`, product).Scan(&gotOnHand, &gotReserved); err != nil || gotOnHand != onHand || gotReserved != reserved {
		t.Fatalf("stock=%d/%d want=%d/%d err=%v", gotOnHand, gotReserved, onHand, reserved, err)
	}
}

func concurrentOrders(t *testing.T, count int, operation func(int) (checkout.Order, error)) ([]checkout.Order, []error) {
	t.Helper()
	start := make(chan struct{})
	var group sync.WaitGroup
	orders := make([]checkout.Order, count)
	failures := make([]error, count)
	for i := range count {
		group.Add(1)
		go func() { defer group.Done(); <-start; orders[i], failures[i] = operation(i) }()
	}
	close(start)
	group.Wait()
	return orders, failures
}

func TestSettlement(t *testing.T) {
	for _, scenario := range []string{"accept", "reject"} {
		t.Run(scenario+" process and immutable replay", func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 5, 1234)
			customer, pending := pendingOrder(t, f, scenario, checkoutLine{product, 2})
			var calls atomic.Int32
			service, err := checkout.NewServiceWithSimulator(f.pool, simulatorFunc(func(ctx context.Context, attempt checkout.Attempt) (checkout.Decision, error) {
				calls.Add(1)
				if f.pool.Stat().AcquiredConns() != 0 {
					return "", errors.New("simulator retained a pooled connection")
				}
				return (checkout.LocalSimulator{}).Evaluate(ctx, attempt)
			}))
			if err != nil {
				t.Fatal(err)
			}
			settled, err := service.Process(f.ctx, customer.user, pending.ID)
			if err != nil {
				t.Fatal(err)
			}
			wantStatus, wantPayment, wantReservation, wantStock := "confirmed", "succeeded", "consumed", 3
			if scenario == "reject" {
				wantStatus, wantPayment, wantReservation, wantStock = "payment_failed", "failed", "released", 5
			}
			if settled.Status != wantStatus || settled.Payment.Status != wantPayment || settled.TotalCents != 2468 {
				t.Fatal("wrong deterministic outcome")
			}
			if scenario == "reject" && (settled.Payment.FailureCode == nil || *settled.Payment.FailureCode != "simulated_decline") {
				t.Fatal("missing safe decline code")
			}
			if scenario == "accept" && settled.Payment.FailureCode != nil {
				t.Fatal("accepted payment has a failure")
			}
			assertOrderState(t, f, pending.ID, wantStatus, wantPayment, wantReservation, 2)
			assertStock(t, f, product, wantStock, 0)
			replay, err := service.Checkout(f.ctx, customer.user, "key", customer.request)
			if err != nil || !replay.Replayed || replay.Order.Status != wantStatus {
				t.Fatal("checkout replay lost terminal outcome")
			}
			if _, err := service.Process(f.ctx, customer.user, pending.ID); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 {
				t.Fatal("retained/terminal order re-ran simulation")
			}
			assertOrderState(t, f, pending.ID, wantStatus, wantPayment, wantReservation, 2)
			assertStock(t, f, product, wantStock, 0)
		})

		t.Run(scenario+" concurrent settlement is once", func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 5, 100)
			customer, pending := pendingOrder(t, f, scenario, checkoutLine{product, 2})
			service := checkout.NewService(f.pool)
			claim, err := service.Claim(f.ctx, customer.user, pending.ID)
			if err != nil || !claim.Claimed {
				t.Fatalf("claim failed: %v", err)
			}
			duplicate, err := service.Claim(f.ctx, customer.user, pending.ID)
			if err != nil || duplicate.Claimed || duplicate.Attempt != claim.Attempt {
				t.Fatal("processing ownership was duplicated")
			}
			decision, err := (checkout.LocalSimulator{}).Evaluate(f.ctx, claim.Attempt)
			if err != nil {
				t.Fatal(err)
			}
			orders, failures := concurrentOrders(t, 20, func(int) (checkout.Order, error) {
				return service.Settle(f.ctx, customer.user, pending.ID, claim.Attempt.ID, decision)
			})
			wantStatus, wantPayment, wantReservation, wantStock := "confirmed", "succeeded", "consumed", 3
			if scenario == "reject" {
				wantStatus, wantPayment, wantReservation, wantStock = "payment_failed", "failed", "released", 5
			}
			for i, err := range failures {
				if err != nil || orders[i].Status != wantStatus {
					t.Fatalf("concurrent finalizer failed: %v", err)
				}
			}
			assertOrderState(t, f, pending.ID, wantStatus, wantPayment, wantReservation, 2)
			assertStock(t, f, product, wantStock, 0)
		})
	}

	t.Run("settlement requires claim and stored decision", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		customer, pending := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		service := checkout.NewService(f.pool)
		if _, err := service.Settle(f.ctx, customer.user, pending.ID, pending.Payment.ID, checkout.Accepted); !errors.Is(err, checkout.ErrSettlementConflict) {
			t.Fatalf("unclaimed attempt settled: %v", err)
		}
		if _, err := service.Claim(f.ctx, customer.user, pending.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.Cancel(f.ctx, customer.user, pending.ID); !errors.Is(err, checkout.ErrCancellationConflict) {
			t.Fatal("processing attempt cancelled")
		}
		if _, err := service.Settle(f.ctx, customer.user, pending.ID, pending.Payment.ID, checkout.Rejected); !errors.Is(err, checkout.ErrIntegrity) {
			t.Fatal("caller overrode stored simulator outcome")
		}
		if _, err := service.Settle(f.ctx, customer.user, pending.ID, checkoutID(t), checkout.Accepted); !errors.Is(err, checkout.ErrIntegrity) {
			t.Fatal("wrong attempt settled")
		}
		assertOrderState(t, f, pending.ID, "pending_payment", "processing", "active", 1)
		assertStock(t, f, product, 5, 1)
	})

	t.Run("concurrent cancellation is once", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		customer, pending := pendingOrder(t, f, "accept", checkoutLine{product, 2})
		service := checkout.NewService(f.pool)
		orders, failures := concurrentOrders(t, 20, func(int) (checkout.Order, error) { return service.Cancel(f.ctx, customer.user, pending.ID) })
		for i, err := range failures {
			if err != nil || orders[i].Status != "cancelled" {
				t.Fatalf("cancellation failed: %v", err)
			}
		}
		claim, err := service.Claim(f.ctx, customer.user, pending.ID)
		if err != nil || claim.Claimed || claim.Order.Status != "cancelled" {
			t.Fatal("cancelled attempt claimed")
		}
		if _, err := service.Settle(f.ctx, customer.user, pending.ID, pending.Payment.ID, checkout.Accepted); !errors.Is(err, checkout.ErrSettlementConflict) {
			t.Fatal("cancelled attempt settled")
		}
		assertOrderState(t, f, pending.ID, "cancelled", "cancelled", "released", 2)
		assertStock(t, f, product, 5, 0)
	})

	t.Run("claim versus cancellation ownership", func(t *testing.T) {
		f := newTestDatabase(t)
		const count = 30
		product := seedCheckoutProduct(t, f, count, 100)
		customers := make([]checkoutCustomer, count)
		pending := make([]checkout.Order, count)
		for i := range count {
			customers[i], pending[i] = pendingOrder(t, f, "accept", checkoutLine{product, 1})
		}
		claims := make([]checkout.Claim, count)
		claimErrors := make([]error, count)
		cancelErrors := make([]error, count)
		start := make(chan struct{})
		var group sync.WaitGroup
		service := checkout.NewService(f.pool)
		for i := range count {
			group.Add(2)
			go func() {
				defer group.Done()
				<-start
				claims[i], claimErrors[i] = service.Claim(f.ctx, customers[i].user, pending[i].ID)
			}()
			go func() {
				defer group.Done()
				<-start
				_, cancelErrors[i] = service.Cancel(f.ctx, customers[i].user, pending[i].ID)
			}()
		}
		close(start)
		group.Wait()
		cancelled := 0
		for i := range count {
			if claimErrors[i] != nil {
				t.Fatal(claimErrors[i])
			}
			if claims[i].Claimed {
				if !errors.Is(cancelErrors[i], checkout.ErrCancellationConflict) {
					t.Fatal("claim winner was cancelled")
				}
				if _, err := service.Settle(f.ctx, customers[i].user, pending[i].ID, claims[i].Attempt.ID, checkout.Accepted); err != nil {
					t.Fatal(err)
				}
				assertOrderState(t, f, pending[i].ID, "confirmed", "succeeded", "consumed", 2)
			} else {
				cancelled++
				if cancelErrors[i] != nil || claims[i].Order.Status != "cancelled" {
					t.Fatalf("cancellation winner was claimed: %v", cancelErrors[i])
				}
				assertOrderState(t, f, pending[i].ID, "cancelled", "cancelled", "released", 2)
			}
		}
		assertStock(t, f, product, cancelled, 0)
	})

	t.Run("interrupted processing does not resume on reads or replay", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		customer := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		var calls atomic.Int32
		service, err := checkout.NewServiceWithSimulator(f.pool, simulatorFunc(func(context.Context, checkout.Attempt) (checkout.Decision, error) {
			calls.Add(1)
			return "", errors.New("test-only simulator interruption")
		}))
		if err != nil {
			t.Fatal(err)
		}
		result, err := service.Checkout(f.ctx, customer.user, "interrupted", customer.request)
		if err != nil || result.Replayed || !result.Interrupted || result.Order.Payment.Status != "processing" {
			t.Fatalf("interrupted T1 not retained: %v", err)
		}
		if _, err := service.GetOrder(f.ctx, customer.user, result.Order.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.ListOrders(f.ctx, customer.user, 20, 0); err != nil {
			t.Fatal(err)
		}
		if _, err := service.Payments(f.ctx, customer.user, result.Order.ID); err != nil {
			t.Fatal(err)
		}
		replay, err := service.Checkout(f.ctx, customer.user, "interrupted", customer.request)
		if err != nil || !replay.Replayed || replay.Interrupted {
			t.Fatal("same key restarted processing")
		}
		if _, err := service.Process(f.ctx, customer.user, result.Order.ID); !errors.Is(err, checkout.ErrProcessingInProgress) {
			t.Fatal("processing ownership was stolen")
		}
		if calls.Load() != 1 {
			t.Fatal("read or retry invoked simulation")
		}
		assertOrderState(t, f, result.Order.ID, "pending_payment", "processing", "active", 1)
		assertStock(t, f, product, 5, 1)
		// An explicit finalizer can safely finish the retained processing attempt;
		// candidate selection and an operator recovery CLI remain Milestone 4.
		if _, err := service.Settle(f.ctx, customer.user, result.Order.ID, result.Order.Payment.ID, checkout.Accepted); err != nil {
			t.Fatal(err)
		}
		assertOrderState(t, f, result.Order.ID, "confirmed", "succeeded", "consumed", 2)
	})

	t.Run("expired threshold does not force rejection", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		customer, pending := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		if _, err := f.migrator.Exec(f.ctx, `UPDATE orders SET created_at=now()-interval '1 hour',reservation_expires_at=now()-interval '45 minutes' WHERE id=$1`, pending.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory_reservations r SET expires_at=o.reservation_expires_at FROM order_items i JOIN orders o ON o.id=i.order_id WHERE r.order_item_id=i.id AND o.id=$1`, pending.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := checkout.NewService(f.pool).Process(f.ctx, customer.user, pending.ID); err != nil {
			t.Fatal(err)
		}
		assertOrderState(t, f, pending.ID, "confirmed", "succeeded", "consumed", 2)
		assertStock(t, f, product, 4, 0)
	})
}

func TestSettlementRollback(t *testing.T) {
	for _, operation := range []string{"settle", "cancel"} {
		t.Run(operation, func(t *testing.T) {
			f := newTestDatabase(t)
			a, b := seedCheckoutProduct(t, f, 5, 100), seedCheckoutProduct(t, f, 5, 100)
			customer, pending := pendingOrder(t, f, "accept", checkoutLine{a, 1}, checkoutLine{b, 1})
			service := checkout.NewService(f.pool)
			paymentStatus := "pending"
			if operation == "settle" {
				if _, err := service.Claim(f.ctx, customer.user, pending.ID); err != nil {
					t.Fatal(err)
				}
				paymentStatus = "processing"
			}
			second := a
			if b > second {
				second = b
			}
			statement := fmt.Sprintf(`CREATE FUNCTION abort_second_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id='%s'::uuid THEN RAISE EXCEPTION 'injected second reservation failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER abort_second_hold BEFORE UPDATE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION abort_second_hold();`, second)
			if _, err := f.migrator.Exec(f.ctx, statement); err != nil {
				t.Fatal(err)
			}
			var err error
			if operation == "settle" {
				_, err = service.Settle(f.ctx, customer.user, pending.ID, pending.Payment.ID, checkout.Accepted)
			} else {
				_, err = service.Cancel(f.ctx, customer.user, pending.ID)
			}
			if err == nil {
				t.Fatal("injected failure unexpectedly committed")
			}
			assertOrderState(t, f, pending.ID, "pending_payment", paymentStatus, "active", 1)
			assertStock(t, f, a, 5, 1)
			assertStock(t, f, b, 5, 1)
			if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER abort_second_hold ON inventory_reservations; DROP FUNCTION abort_second_hold();`); err != nil {
				t.Fatal(err)
			}
			if operation == "settle" {
				_, err = service.Settle(f.ctx, customer.user, pending.ID, pending.Payment.ID, checkout.Accepted)
			} else {
				_, err = service.Cancel(f.ctx, customer.user, pending.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if operation == "settle" {
				assertOrderState(t, f, pending.ID, "confirmed", "succeeded", "consumed", 2)
				assertStock(t, f, a, 4, 0)
			} else {
				assertOrderState(t, f, pending.ID, "cancelled", "cancelled", "released", 2)
				assertStock(t, f, a, 5, 0)
			}
		})
	}
}

func TestSettlementRetries(t *testing.T) {
	for _, tc := range []struct {
		code               string
		failures, attempts int
		success            bool
	}{{"40P01", 1, 2, true}, {"40001", 2, 3, true}, {"40001", 100, 3, false}, {"P0001", 1, 1, false}} {
		t.Run(fmt.Sprintf("%s_%d", tc.code, tc.failures), func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 5, 100)
			customer, pending := pendingOrder(t, f, "accept", checkoutLine{product, 1})
			service := checkout.NewService(f.pool)
			if _, err := service.Claim(f.ctx, customer.user, pending.ID); err != nil {
				t.Fatal(err)
			}
			statement := fmt.Sprintf(`CREATE SEQUENCE settlement_attempts; CREATE FUNCTION retry_settlement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE attempt bigint; BEGIN attempt:=nextval('public.settlement_attempts'); IF attempt<=%d THEN RAISE EXCEPTION 'injected settlement abort' USING ERRCODE='%s'; END IF; RETURN NEW; END $$; CREATE TRIGGER retry_settlement BEFORE INSERT ON order_status_history FOR EACH ROW EXECUTE FUNCTION retry_settlement();`, tc.failures, tc.code)
			if _, err := f.migrator.Exec(f.ctx, statement); err != nil {
				t.Fatal(err)
			}
			_, err := service.Settle(f.ctx, customer.user, pending.ID, pending.Payment.ID, checkout.Accepted)
			if tc.success {
				if err != nil {
					t.Fatal(err)
				}
				assertOrderState(t, f, pending.ID, "confirmed", "succeeded", "consumed", 2)
				assertStock(t, f, product, 4, 0)
			} else {
				var pgError *pgconn.PgError
				if !errors.As(err, &pgError) || pgError.Code != tc.code {
					t.Fatalf("incorrect abort error: %v", err)
				}
				assertOrderState(t, f, pending.ID, "pending_payment", "processing", "active", 1)
				assertStock(t, f, product, 5, 1)
			}
			var attempts int
			if err := f.migrator.QueryRow(f.ctx, `SELECT last_value FROM settlement_attempts`).Scan(&attempts); err != nil || attempts != tc.attempts {
				t.Fatalf("attempt count=%d want=%d err=%v", attempts, tc.attempts, err)
			}
		})
	}
}
