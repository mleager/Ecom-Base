//go:build integration

package integration

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"ecom/backend/internal/checkout"
)

func TestRecoveryCommitUncertainty(t *testing.T) {
	for _, target := range []int32{1, 2} {
		for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter, commitDelayed} {
			t.Run(fmt.Sprintf("commit=%d mode=%d", target, mode), func(t *testing.T) {
				f := newTestDatabase(t)
				product := seedCheckoutProduct(t, f, 5, 100)
				_, order := pendingOrder(t, f, "accept", checkoutLine{product, 1})
				expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
				pool, fault := newCommitFaultPool(t, f, mode)
				fault.target = target
				report, err := checkout.NewService(pool).Recover(f.ctx, 100, nil)
				if !fault.used.Load() {
					t.Fatal("COMMIT fault did not run")
				}
				if mode == commitDropAfter {
					if err != nil || report.Settled != 1 || report.Uncertain != 0 {
						t.Fatalf("committed state not resolved: %+v %v", report, err)
					}
				} else if !errors.Is(err, checkout.ErrRecoveryIssues) || report.Uncertain != 1 || report.Settled != 0 {
					t.Fatalf("unknown outcome treated as rollback/success: %+v %v", report, err)
				}
				fault.once.Do(func() { close(fault.release) })
				awaitCommitFault(t, fault)
				if _, err := checkout.NewService(f.pool).Recover(f.ctx, 100, nil); err != nil {
					t.Fatal(err)
				}
				assertOrderState(t, f, order.ID, "confirmed", "succeeded", "consumed", 2)
				assertStock(t, f, product, 4, 0)
				before := recoverySnapshot(t, f)
				if report, err := checkout.NewService(f.pool).Recover(f.ctx, 100, nil); err != nil || report.Visited != 0 || before != recoverySnapshot(t, f) {
					t.Fatal("second retry changed settled state")
				}
			})
		}
	}
	t.Run("terminal resolution refuses corrupt reservation state", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		_, order := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
		pool, fault := newCommitFaultPool(t, f, commitDropAfter)
		fault.target = 2
		injected := make(chan error, 1)
		fault.cancel = func() {
			_, err := f.migrator.Exec(f.ctx, `UPDATE inventory_reservations SET status='released'`)
			injected <- err
		}
		report, err := checkout.NewService(pool).Recover(f.ctx, 100, nil)
		awaitCommitFault(t, fault)
		if injectErr := <-injected; injectErr != nil {
			t.Fatal(injectErr)
		}
		if !errors.Is(err, checkout.ErrRecoveryIssues) || report.Inconsistent != 1 || report.Settled != 0 {
			t.Fatalf("corrupt terminal result reported as success: %+v %v", report, err)
		}
		assertStock(t, f, product, 4, 0)
	})
}

func TestRecoveryRetries(t *testing.T) {
	for _, tc := range []struct {
		code               string
		failures, attempts int
		success            bool
	}{
		{"40P01", 1, 2, true},
		{"40001", 2, 3, true},
		{"40001", 100, 3, false},
		{"P0001", 1, 1, false},
	} {
		t.Run(tc.code, func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 5, 100)
			_, order := pendingOrder(t, f, "accept", checkoutLine{product, 1})
			expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
			statement := fmt.Sprintf(`CREATE SEQUENCE recovery_tries; CREATE FUNCTION recovery_retry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE attempt bigint; BEGIN attempt:=nextval('public.recovery_tries'); IF attempt<=%d THEN RAISE EXCEPTION 'private injected failure' USING ERRCODE='%s'; END IF; RETURN NEW; END $$; CREATE TRIGGER recovery_retry BEFORE UPDATE ON payment_attempts FOR EACH ROW WHEN (NEW.status='processing') EXECUTE FUNCTION recovery_retry();`, tc.failures, tc.code)
			if _, err := f.migrator.Exec(f.ctx, statement); err != nil {
				t.Fatal(err)
			}
			report, err := checkout.NewService(f.pool).Recover(f.ctx, 100, nil)
			if tc.success {
				if err != nil || report.Settled != 1 {
					t.Fatalf("retry failed: %+v %v", report, err)
				}
				assertOrderState(t, f, order.ID, "confirmed", "succeeded", "consumed", 2)
			} else {
				if !errors.Is(err, checkout.ErrRecoveryIssues) || report.Failed != 1 || report.Visited != 1 {
					t.Fatalf("failed retry report: %+v %v", report, err)
				}
				assertOrderState(t, f, order.ID, "pending_payment", "pending", "active", 1)
				assertStock(t, f, product, 5, 1)
			}
			var attempts int
			if err := f.migrator.QueryRow(f.ctx, `SELECT last_value FROM recovery_tries`).Scan(&attempts); err != nil || attempts != tc.attempts {
				t.Fatalf("attempts=%d want=%d err=%v", attempts, tc.attempts, err)
			}
		})
	}
}
