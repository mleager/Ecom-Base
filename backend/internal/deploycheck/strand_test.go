//go:build deploycheck

package deploycheck

import (
	"context"
	"crypto/rand"
	"os"
	"testing"
	"time"

	"ecom/backend/internal/checkout"
	"ecom/backend/internal/platform/database"

	"github.com/jackc/pgx/v5"
)

// TestStrandOrder creates a pending order from the customer's cart through
// the checkout service, as an API that crashed after T1 would leave it, then
// moves its reservation deadline into the past so reconcile finds it. It is
// the same technique as the fixture tool's checkout-pending command and the
// recovery integration tests.
func TestStrandOrder(t *testing.T) {
	appURL, migratorURL, email := os.Getenv("DEPLOYCHECK_APP_URL"), os.Getenv("DEPLOYCHECK_MIGRATOR_URL"), os.Getenv("DEPLOYCHECK_EMAIL")
	if appURL == "" || migratorURL == "" || email == "" {
		t.Fatal("set DEPLOYCHECK_APP_URL, DEPLOYCHECK_MIGRATOR_URL and DEPLOYCHECK_EMAIL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := database.Open(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	var userID, addressID string
	var version int64
	err = pool.QueryRow(ctx, `SELECT u.id::text, c.version, a.id::text
FROM users u JOIN carts c ON c.user_id=u.id JOIN addresses a ON a.user_id=u.id
WHERE u.email=$1 ORDER BY a.id LIMIT 1`, email).Scan(&userID, &version, &addressID)
	if err != nil {
		t.Fatalf("customer, cart or address missing: %v", err)
	}

	created, err := checkout.NewService(pool).CreatePending(ctx, userID, rand.Text(), checkout.Request{CartVersion: version, ShippingAddressID: addressID, PaymentScenario: "accept"})
	if err != nil {
		t.Fatalf("create pending order: %v", err)
	}
	if created.Order.Status != "pending_payment" {
		t.Fatalf("order status = %s", created.Order.Status)
	}

	migrator, err := pgx.Connect(ctx, migratorURL)
	if err != nil {
		t.Fatal("could not connect as migrator")
	}
	defer func() { _ = migrator.Close(context.Background()) }()
	stamp := time.Now().UTC().Add(-time.Hour)
	if _, err := migrator.Exec(ctx, `UPDATE orders SET created_at=$2,reservation_expires_at=$2::timestamptz+interval '15 minutes' WHERE id=$1`, created.Order.ID, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.Exec(ctx, `UPDATE inventory_reservations r SET expires_at=o.reservation_expires_at FROM order_items i JOIN orders o ON o.id=i.order_id WHERE r.order_item_id=i.id AND o.id=$1`, created.Order.ID); err != nil {
		t.Fatal(err)
	}
	t.Logf("order_id=%s", created.Order.ID)
}
