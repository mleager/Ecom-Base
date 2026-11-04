//go:build integration

package integration

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ecom/backend/internal/checkout"
)

func TestRecoveryApply(t *testing.T) {
	for _, scenario := range []string{"accept", "reject"} {
		for _, processing := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s processing=%v", scenario, processing), func(t *testing.T) {
				f := newTestDatabase(t)
				product := seedCheckoutProduct(t, f, 5, 100)
				customer, order := pendingOrder(t, f, scenario, checkoutLine{product, 2})
				expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
				if processing {
					if _, err := checkout.NewService(f.pool).Claim(f.ctx, customer.user, order.ID); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET is_active=false WHERE id=$1`, customer.user); err != nil {
					t.Fatal(err)
				}
				var calls atomic.Int32
				service, err := checkout.NewServiceWithSimulator(f.pool, simulatorFunc(func(ctx context.Context, attempt checkout.Attempt) (checkout.Decision, error) {
					calls.Add(1)
					if f.pool.Stat().AcquiredConns() != 0 {
						return "", errors.New("recovery retained locks during simulation")
					}
					return (checkout.LocalSimulator{}).Evaluate(ctx, attempt)
				}))
				if err != nil {
					t.Fatal(err)
				}
				var events []checkout.RecoveryEvent
				report, err := service.Recover(f.ctx, 100, collectRecovery(&events))
				wantAction := "claimed"
				if processing {
					wantAction = "resumed"
				}
				if err != nil || report.Mode != "apply" || report.Visited != 1 || report.Settled != 1 || len(events) != 2 || events[0].Event != wantAction || events[1].Event != "settled" || calls.Load() != 1 {
					t.Fatalf("recovery report=%+v events=%+v err=%v", report, events, err)
				}
				if scenario == "accept" {
					assertOrderState(t, f, order.ID, "confirmed", "succeeded", "consumed", 2)
					assertStock(t, f, product, 3, 0)
				} else {
					assertOrderState(t, f, order.ID, "payment_failed", "failed", "released", 2)
					assertStock(t, f, product, 5, 0)
				}
				before := recoverySnapshot(t, f)
				report, err = service.Recover(f.ctx, 100, nil)
				if err != nil || report.Visited != 0 || calls.Load() != 1 || before != recoverySnapshot(t, f) {
					t.Fatal("repeated recovery changed terminal state")
				}
			})
		}
	}
	t.Run("SKIP LOCKED and visit limit", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		stamp := time.Now().UTC().Add(-time.Hour)
		ids := []string{}
		for range 3 {
			_, order := pendingOrder(t, f, "accept", checkoutLine{product, 1})
			expireRecoveryOrder(t, f, order.ID, stamp)
			ids = append(ids, order.ID)
		}
		sort.Strings(ids)
		tx, err := f.pool.Begin(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(f.ctx, `SELECT id FROM orders WHERE id=$1 FOR UPDATE`, ids[0]); err != nil {
			t.Fatal(err)
		}
		var events []checkout.RecoveryEvent
		ctx, cancel := recoveryContext(f.ctx)
		defer cancel()
		service := checkout.NewService(f.pool)
		report, err := service.Recover(ctx, 1, collectRecovery(&events))
		if err != nil || report.Visited != 1 || report.Settled != 1 || events[0].OrderID != ids[1] {
			t.Fatalf("locked order not skipped: %+v %v", report, err)
		}
		if err := tx.Rollback(f.ctx); err != nil {
			t.Fatal(err)
		}
		report, err = service.Recover(f.ctx, 100, nil)
		if err != nil || report.Settled != 2 {
			t.Fatalf("skipped order not recovered next run: %+v %v", report, err)
		}
		assertStock(t, f, product, 7, 0)
		assertCheckoutIntegrity(t, f)
	})
	t.Run("fixed cutoff excludes orders expiring during run", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		_, past := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		_, future := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		expireRecoveryOrder(t, f, past.ID, time.Now().UTC().Add(-time.Hour))
		report, err := checkout.NewService(f.pool).Recover(f.ctx, 100, func(event checkout.RecoveryEvent) error {
			if event.Event == "claimed" {
				var stamp time.Time
				if err := f.migrator.QueryRow(f.ctx, `SELECT clock_timestamp()`).Scan(&stamp); err != nil {
					return err
				}
				expireRecoveryOrder(t, f, future.ID, stamp.Add(-15*time.Minute))
			}
			return nil
		})
		if err != nil || report.Visited != 1 || report.Settled != 1 {
			t.Fatalf("cutoff moved during run: %+v %v", report, err)
		}
		assertOrderState(t, f, future.ID, "pending_payment", "pending", "active", 1)
		report, err = checkout.NewService(f.pool).Recover(f.ctx, 100, nil)
		if err != nil || report.Settled != 1 {
			t.Fatal("newly expired order missing in next run")
		}
		assertStock(t, f, product, 3, 0)
	})
	t.Run("corrupt candidates count toward limit and do not block healthy ones", func(t *testing.T) {
		f := newTestDatabase(t)
		badProduct := seedCheckoutProduct(t, f, 5, 100)
		goodProduct := seedCheckoutProduct(t, f, 5, 100)
		_, bad := pendingOrder(t, f, "accept", checkoutLine{badProduct, 1})
		_, good := pendingOrder(t, f, "accept", checkoutLine{goodProduct, 1})
		expireRecoveryOrder(t, f, bad.ID, time.Now().UTC().Add(-2*time.Hour))
		expireRecoveryOrder(t, f, good.ID, time.Now().UTC().Add(-time.Hour))
		if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory SET quantity_reserved=2 WHERE product_id=$1`, badProduct); err != nil {
			t.Fatal(err)
		}
		service := checkout.NewService(f.pool)
		report, err := service.Recover(f.ctx, 1, nil)
		if !errors.Is(err, checkout.ErrRecoveryIssues) || report.Visited != 1 || report.Inconsistent != 1 || report.Settled != 0 {
			t.Fatalf("invalid record did not count: %+v %v", report, err)
		}
		report, err = service.Recover(f.ctx, 100, nil)
		if !errors.Is(err, checkout.ErrRecoveryIssues) || report.Visited != 2 || report.Inconsistent != 1 || report.Settled != 1 {
			t.Fatalf("cursor did not advance past corruption: %+v %v", report, err)
		}
		assertStock(t, f, badProduct, 5, 2)
		assertStock(t, f, goodProduct, 4, 0)
	})
	t.Run("audit output failure leaves committed claim recoverable", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		_, order := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
		service := checkout.NewService(f.pool)
		if _, err := service.Recover(f.ctx, 1, func(checkout.RecoveryEvent) error { return errors.New("output closed") }); !errors.Is(err, checkout.ErrRecoveryOutput) {
			t.Fatal("audit failure ignored")
		}
		assertOrderState(t, f, order.ID, "pending_payment", "processing", "active", 1)
		if _, err := service.Recover(f.ctx, 1, nil); err != nil {
			t.Fatal(err)
		}
		assertStock(t, f, product, 4, 0)
	})
	t.Run("cancellation after claim leaves resumable processing", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		_, order := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
		ctx, cancel := context.WithCancel(f.ctx)
		defer cancel()
		report, err := checkout.NewService(f.pool).Recover(ctx, 100, func(event checkout.RecoveryEvent) error {
			if event.Event == "claimed" {
				cancel()
			}
			return nil
		})
		if !errors.Is(err, context.Canceled) || report.Settled != 0 {
			t.Fatalf("cancelled command ignored cancellation: %+v %v", report, err)
		}
		assertOrderState(t, f, order.ID, "pending_payment", "processing", "active", 1)
		if _, err := checkout.NewService(f.pool).Recover(f.ctx, 100, nil); err != nil {
			t.Fatal(err)
		}
		assertStock(t, f, product, 4, 0)
	})
}

func TestRecoveryConcurrency(t *testing.T) {
	t.Run("two operators can derive one processing attempt", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		_, order := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
		entered, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		t.Cleanup(func() { once.Do(func() { close(release) }) })
		first, err := checkout.NewServiceWithSimulator(f.pool, simulatorFunc(func(ctx context.Context, attempt checkout.Attempt) (checkout.Decision, error) {
			close(entered)
			select {
			case <-release:
				return (checkout.LocalSimulator{}).Evaluate(ctx, attempt)
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}))
		if err != nil {
			t.Fatal(err)
		}
		finished := make(chan error, 1)
		go func() { _, err := first.Recover(f.ctx, 100, nil); finished <- err }()
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("first operator never entered simulation")
		}
		report, err := checkout.NewService(f.pool).Recover(f.ctx, 100, nil)
		if err != nil || report.Settled != 1 {
			t.Fatalf("second operator did not resume: %+v %v", report, err)
		}
		once.Do(func() { close(release) })
		if err := <-finished; err != nil {
			t.Fatal(err)
		}
		assertOrderState(t, f, order.ID, "confirmed", "succeeded", "consumed", 2)
		assertStock(t, f, product, 4, 0)
	})
	t.Run("recovery races cancellation across thirty orders", func(t *testing.T) {
		f := newTestDatabase(t)
		const count = 30
		product := seedCheckoutProduct(t, f, count, 100)
		customers := make([]checkoutCustomer, count)
		orders := make([]checkout.Order, count)
		for i := range count {
			customers[i], orders[i] = pendingOrder(t, f, "accept", checkoutLine{product, 1})
			expireRecoveryOrder(t, f, orders[i].ID, time.Now().UTC().Add(-time.Hour))
		}
		service := checkout.NewService(f.pool)
		start := make(chan struct{})
		var group sync.WaitGroup
		cancelErrors := make([]error, count)
		recoverErrors := make([]error, 2)
		for i := range count {
			group.Add(1)
			go func() {
				defer group.Done()
				<-start
				_, cancelErrors[i] = service.Cancel(f.ctx, customers[i].user, orders[i].ID)
			}()
		}
		for i := range 2 {
			group.Add(1)
			go func() { defer group.Done(); <-start; _, recoverErrors[i] = service.Recover(f.ctx, 100, nil) }()
		}
		close(start)
		group.Wait()
		for _, err := range recoverErrors {
			if err != nil {
				t.Fatal(err)
			}
		}
		cancelled := 0
		for i, err := range cancelErrors {
			switch {
			case err == nil:
				cancelled++
				assertOrderState(t, f, orders[i].ID, "cancelled", "cancelled", "released", 2)
			case errors.Is(err, checkout.ErrCancellationConflict):
				assertOrderState(t, f, orders[i].ID, "confirmed", "succeeded", "consumed", 2)
			default:
				t.Fatal(err)
			}
		}
		assertStock(t, f, product, int(cancelled), 0)
	})
}

func TestRecoveryRollback(t *testing.T) {
	f := newTestDatabase(t)
	a, b := seedCheckoutProduct(t, f, 5, 100), seedCheckoutProduct(t, f, 5, 100)
	_, order := pendingOrder(t, f, "accept", checkoutLine{a, 1}, checkoutLine{b, 1})
	expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
	ids := []string{a, b}
	sort.Strings(ids)
	statement := fmt.Sprintf(`CREATE FUNCTION recovery_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id='%s'::uuid THEN RAISE EXCEPTION 'private injected SQL detail'; END IF; RETURN NEW; END $$; CREATE TRIGGER recovery_abort BEFORE UPDATE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION recovery_abort();`, ids[1])
	if _, err := f.migrator.Exec(f.ctx, statement); err != nil {
		t.Fatal(err)
	}
	report, err := checkout.NewService(f.pool).Recover(f.ctx, 100, nil)
	if !errors.Is(err, checkout.ErrRecoveryIssues) || report.Failed != 1 || report.Visited != 1 {
		t.Fatalf("rollback not reported: %+v %v", report, err)
	}
	assertOrderState(t, f, order.ID, "pending_payment", "processing", "active", 1)
	assertStock(t, f, a, 5, 1)
	assertStock(t, f, b, 5, 1)
	if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER recovery_abort ON inventory_reservations; DROP FUNCTION recovery_abort()`); err != nil {
		t.Fatal(err)
	}
	if _, err := checkout.NewService(f.pool).Recover(f.ctx, 100, nil); err != nil {
		t.Fatal(err)
	}
	assertOrderState(t, f, order.ID, "confirmed", "succeeded", "consumed", 2)
	assertStock(t, f, a, 4, 0)
	assertStock(t, f, b, 4, 0)
}
