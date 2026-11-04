//go:build integration

package integration

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"ecom/backend/internal/checkout"
)

func expireRecoveryOrder(t *testing.T, f *testDatabase, id string, stamp time.Time) {
	t.Helper()
	if _, err := f.migrator.Exec(f.ctx, `UPDATE orders SET created_at=$2,reservation_expires_at=$2::timestamptz+interval '15 minutes' WHERE id=$1`, id, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory_reservations r SET expires_at=o.reservation_expires_at FROM order_items i JOIN orders o ON o.id=i.order_id WHERE r.order_item_id=i.id AND o.id=$1`, id); err != nil {
		t.Fatal(err)
	}
}

func recoverySnapshot(t *testing.T, f *testDatabase) string {
	t.Helper()
	var snapshot string
	if err := f.migrator.QueryRow(f.ctx, `SELECT jsonb_build_object(
 'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM orders o),
 'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM order_items i),
 'payments',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payment_attempts p),
 'reservations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM inventory_reservations r),
 'inventory',(SELECT jsonb_agg(to_jsonb(v) ORDER BY product_id) FROM inventory v),
 'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM order_status_history h),
 'idempotency',(SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM checkout_idempotency k),
 'carts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM carts c)
 )::text`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestRecoveryDiscovery(t *testing.T) {
	f := newTestDatabase(t)
	product := seedCheckoutProduct(t, f, 10, 100)
	stamp := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	ids := []string{}
	for range 3 {
		_, pending := pendingOrder(t, f, "accept", checkoutLine{product, 1})
		expireRecoveryOrder(t, f, pending.ID, stamp)
		ids = append(ids, pending.ID)
	}
	_, future := pendingOrder(t, f, "accept", checkoutLine{product, 1})
	sort.Strings(ids)
	service := checkout.NewService(f.pool)
	before := recoverySnapshot(t, f)
	var events []checkout.RecoveryEvent
	report, err := service.InspectRecovery(f.ctx, 2, func(event checkout.RecoveryEvent) error { events = append(events, event); return nil })
	if err != nil || report.Mode != "dry-run" || report.Visited != 2 || report.DiagnosticCount != 0 || len(events) != 2 || report.Cutoff.IsZero() {
		t.Fatalf("dry-run report=%+v err=%v", report, err)
	}
	for i, event := range events {
		if event.Event != "candidate" || event.OrderID != ids[i] || event.OrderID == future.ID || event.PaymentStatus != "pending" || !event.Deadline.Equal(stamp.Add(15*time.Minute)) {
			t.Fatalf("unexpected candidate %+v", event)
		}
	}
	if before != recoverySnapshot(t, f) {
		t.Fatal("dry-run changed persisted state or timestamps")
	}
	for _, limit := range []int{0, -1, 1001} {
		if _, err := service.InspectRecovery(f.ctx, limit, nil); !errors.Is(err, checkout.ErrInvalidInput) {
			t.Fatal("invalid visit limit accepted")
		}
	}
	if _, err := service.InspectRecovery(f.ctx, 1, func(checkout.RecoveryEvent) error { return errors.New("private output failure") }); !errors.Is(err, checkout.ErrRecoveryOutput) {
		t.Fatal("output failure not surfaced safely")
	}
	if before != recoverySnapshot(t, f) {
		t.Fatal("failed dry-run changed data")
	}
}

func TestRecoveryDiagnostics(t *testing.T) {
	for _, tc := range []struct{ sql, code string }{
		{`UPDATE inventory SET quantity_reserved=quantity_reserved+1`, "inventory_aggregate"},
		{`UPDATE inventory_reservations SET quantity=quantity+1`, "reservation_link_or_state"},
		{`UPDATE inventory_reservations SET expires_at=expires_at+interval '1 second'`, "reservation_link_or_state"},
		{`DELETE FROM inventory_reservations`, "reservation_missing"},
		{`UPDATE orders SET subtotal_cents=200,total_cents=200`, "order_totals"},
		{`UPDATE orders SET reservation_expires_at=reservation_expires_at+interval '1 second'`, "order_deadline"},
		{`UPDATE payment_attempts SET status='processing'`, "payment_state"},
		{`DELETE FROM payment_attempts`, "payment_cardinality"},
	} {
		t.Run(tc.code+tc.sql, func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 5, 100)
			_, order := pendingOrder(t, f, "accept", checkoutLine{product, 1})
			expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
			if _, err := f.migrator.Exec(f.ctx, tc.sql); err != nil {
				t.Fatal(err)
			}
			before := recoverySnapshot(t, f)
			report, err := checkout.NewService(f.pool).InspectRecovery(f.ctx, 100, nil)
			if !errors.Is(err, checkout.ErrRecoveryIssues) || report.DiagnosticCount == 0 {
				t.Fatalf("corruption not detected: %+v %v", report, err)
			}
			found := false
			for _, finding := range report.DiagnosticFindings {
				found = found || finding.Code == tc.code
			}
			if !found || before != recoverySnapshot(t, f) {
				t.Fatal("diagnostic missing or changed data")
			}
		})
	}
	t.Run("bounded findings retain exact total", func(t *testing.T) {
		f := newTestDatabase(t)
		for range 105 {
			seedCheckoutProduct(t, f, 2, 100)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory SET quantity_reserved=1`); err != nil {
			t.Fatal(err)
		}
		report, err := checkout.NewService(f.pool).InspectRecovery(f.ctx, 1, nil)
		if !errors.Is(err, checkout.ErrRecoveryIssues) || report.DiagnosticCount != 105 || len(report.DiagnosticFindings) != 100 || report.Visited != 0 {
			t.Fatalf("diagnostic bounds: %+v %v", report, err)
		}
	})
	t.Run("snapshot remains consistent across concurrent settlement", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 5, 100)
		customers := make([]checkoutCustomer, 2)
		orders := make([]checkout.Order, 2)
		for i := range 2 {
			customers[i], orders[i] = pendingOrder(t, f, "accept", checkoutLine{product, 1})
			expireRecoveryOrder(t, f, orders[i].ID, time.Now().UTC().Add(-time.Hour))
		}
		service := checkout.NewService(f.pool)
		visited := 0
		report, err := service.InspectRecovery(f.ctx, 100, func(event checkout.RecoveryEvent) error {
			visited++
			if visited == 1 {
				for i := range 2 {
					if _, err := service.Process(f.ctx, customers[i].user, orders[i].ID); err != nil {
						return err
					}
				}
			}
			if event.PaymentStatus != "pending" {
				return fmt.Errorf("snapshot mixed revisions: %s", event.PaymentStatus)
			}
			return nil
		})
		if err != nil || report.DiagnosticCount != 0 || report.Visited != 2 {
			t.Fatalf("inconsistent diagnostic snapshot: %+v %v", report, err)
		}
		assertStock(t, f, product, 3, 0)
		assertCheckoutIntegrity(t, f)
	})
}

func collectRecovery(events *[]checkout.RecoveryEvent) func(checkout.RecoveryEvent) error {
	return func(event checkout.RecoveryEvent) error { *events = append(*events, event); return nil }
}

func recoveryContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 15*time.Second)
}
