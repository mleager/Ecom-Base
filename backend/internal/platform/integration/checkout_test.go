//go:build integration

package integration

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/httpserver"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func checkoutID(t *testing.T) string {
	t.Helper()
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal(err)
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

type checkoutLine struct {
	product  string
	quantity int32
}
type checkoutCustomer struct {
	user, cart, address string
	request             checkout.Request
}

func seedCheckoutProduct(t *testing.T, f *testDatabase, stock int32, price int64) string {
	t.Helper()
	id := checkoutID(t)
	if _, err := f.migrator.Exec(f.ctx, `INSERT INTO products(id,sku,name,unit_price_cents) VALUES($1,$2,'Original name',$3)`, id, "SKU-"+id, price); err != nil {
		t.Fatal(err)
	}
	if _, err := f.migrator.Exec(f.ctx, `INSERT INTO inventory(product_id,quantity_on_hand) VALUES($1,$2)`, id, stock); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedCheckoutCustomer(t *testing.T, f *testDatabase, lines ...checkoutLine) checkoutCustomer {
	t.Helper()
	c := checkoutCustomer{user: checkoutID(t), cart: checkoutID(t), address: checkoutID(t)}
	c.request = checkout.Request{CartVersion: 1, ShippingAddressID: c.address, PaymentScenario: "accept"}
	batch := &pgx.Batch{}
	// Explicit fixtures represent already authenticated customers. Password
	// verification/session behavior is covered by the authentication suite.
	batch.Queue(`INSERT INTO users(id,first_name,last_name,email,password_hash) VALUES($1,'Test','Buyer',$2,'test-fixture-only')`, c.user, c.user+"@example.com")
	batch.Queue(`INSERT INTO carts(id,user_id) VALUES($1,$2)`, c.cart, c.user)
	batch.Queue(`INSERT INTO addresses(id,user_id,label,recipient_name,line_1,line_2,city,region,postal_code) VALUES($1,$2,'Home','Test Buyer','1 Main St','Unit 2','Portland','OR','97201')`, c.address, c.user)
	for _, line := range lines {
		batch.Queue(`INSERT INTO cart_items(id,cart_id,product_id,quantity) VALUES($1,$2,$3,$4)`, checkoutID(t), c.cart, line.product, line.quantity)
	}
	results := f.migrator.SendBatch(f.ctx, batch)
	defer func() {
		if err := results.Close(); err != nil {
			t.Error(err)
		}
	}()
	for range batch.Len() {
		if _, err := results.Exec(); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func checkoutCounts(t *testing.T, f *testDatabase) [6]int {
	t.Helper()
	var counts [6]int
	err := f.migrator.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM orders),(SELECT count(*) FROM order_items),(SELECT count(*) FROM inventory_reservations),(SELECT count(*) FROM payment_attempts),(SELECT count(*) FROM checkout_idempotency),(SELECT count(*) FROM order_status_history)`).Scan(&counts[0], &counts[1], &counts[2], &counts[3], &counts[4], &counts[5])
	if err != nil {
		t.Fatal(err)
	}
	return counts
}

func assertCheckoutIntegrity(t *testing.T, f *testDatabase) {
	t.Helper()
	tx, err := f.migrator.BeginTx(f.ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	queries := []string{
		`SELECT count(*) FROM inventory i WHERE i.quantity_reserved<>(SELECT coalesce(sum(r.quantity),0) FROM inventory_reservations r WHERE r.product_id=i.product_id AND r.status='active')`,
		`SELECT count(*) FROM inventory_reservations r JOIN order_items i ON i.id=r.order_item_id JOIN orders o ON o.id=i.order_id WHERE r.product_id<>i.product_id OR r.quantity<>i.quantity OR r.expires_at<>o.reservation_expires_at`,
		`SELECT count(*) FROM orders o WHERE o.total_cents<>o.subtotal_cents OR o.total_cents<>(SELECT coalesce(sum(i.line_total_cents),0) FROM order_items i WHERE i.order_id=o.id) OR o.reservation_expires_at<>o.created_at+interval '15 minutes' OR NOT EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id) OR (SELECT count(*) FROM payment_attempts p WHERE p.order_id=o.id)<>1 OR (SELECT count(*) FROM checkout_idempotency c WHERE c.order_id=o.id)<>1`,
		`SELECT count(*) FROM order_items WHERE line_total_cents<>quantity::bigint*unit_price_cents OR unit_price_cents>1000000000000 OR line_total_cents>1000000000000`,
		`SELECT count(*) FROM payment_attempts WHERE attempt_number<>1 OR simulator_reference<>id::text`,
	}
	for _, query := range queries {
		var violations int
		if err := tx.QueryRow(f.ctx, query).Scan(&violations); err != nil || violations != 0 {
			t.Fatalf("checkout integrity violations=%d err=%v", violations, err)
		}
	}
}

func assertCheckoutRolledBack(t *testing.T, f *testDatabase, c checkoutCustomer) {
	t.Helper()
	if got := checkoutCounts(t, f); got != [6]int{} {
		t.Fatalf("partial checkout rows survived: %v", got)
	}
	var version int64
	var items int
	if err := f.migrator.QueryRow(f.ctx, `SELECT version,(SELECT count(*) FROM cart_items WHERE cart_id=carts.id) FROM carts WHERE id=$1`, c.cart).Scan(&version, &items); err != nil || version != 1 {
		t.Fatalf("failed checkout changed cart version=%d err=%v", version, err)
	}
	assertCheckoutIntegrity(t, f)
}

type checkoutCall struct {
	customer checkoutCustomer
	key      string
}

func concurrentCheckouts(t *testing.T, f *testDatabase, calls []checkoutCall) ([]checkout.Result, []error) {
	t.Helper()
	service := checkout.NewService(f.pool)
	results := make([]checkout.Result, len(calls))
	failures := make([]error, len(calls))
	start := make(chan struct{})
	var group sync.WaitGroup
	for i, call := range calls {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			results[i], failures[i] = service.CreatePending(f.ctx, call.customer.user, call.key, call.customer.request)
		}()
	}
	close(start)
	group.Wait()
	return results, failures
}

func TestCheckout(t *testing.T) {
	t.Run("atomic pending order snapshots and durable replay", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 1234)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 2})
		service := checkout.NewService(f.pool)
		result, err := service.CreatePending(f.ctx, c.user, "original-key", c.request)
		if err != nil {
			t.Fatal(err)
		}
		order := result.Order
		if result.Replayed || order.Status != "pending_payment" || order.TotalCents != 2468 || order.Currency != "USD" || len(order.Items) != 1 || order.Items[0].Quantity != 2 || order.Items[0].UnitPriceCents != 1234 || order.Payment.Status != "pending" || order.ShippingAddress.CountryCode != "US" || order.ShippingAddress.Line1 != "1 Main St" {
			t.Fatal("incorrect pending order or snapshots")
		}
		if got := checkoutCounts(t, f); got != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatalf("incomplete T1 rows: %v", got)
		}
		cart, err := commerce.NewService(f.pool).GetCart(f.ctx, c.user)
		if err != nil || cart.Version != 2 || len(cart.Items) != 0 {
			t.Fatal("cart consumption did not commit")
		}
		var onHand, reserved int
		var validHistory bool
		if err := f.migrator.QueryRow(f.ctx, `SELECT quantity_on_hand,quantity_reserved FROM inventory WHERE product_id=$1`, product).Scan(&onHand, &reserved); err != nil || onHand != 10 || reserved != 2 {
			t.Fatal("T1 must only hold stock")
		}
		if err := f.migrator.QueryRow(f.ctx, `SELECT previous_status IS NULL AND new_status='pending_payment' AND reason='checkout_created' FROM order_status_history WHERE order_id=$1`, order.ID).Scan(&validHistory); err != nil || !validHistory {
			t.Fatal("initial history missing")
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE products SET name='Changed',sku='CHANGED',unit_price_cents=9999,is_active=false WHERE id=$1`, product); err != nil {
			t.Fatal(err)
		}
		if _, err := f.migrator.Exec(f.ctx, `DELETE FROM addresses WHERE id=$1`, c.address); err != nil {
			t.Fatal(err)
		}
		// A new cart version and a deleted address cannot invalidate the old intent.
		if err := commerce.NewService(f.pool).ClearCart(f.ctx, c.user); err != nil {
			t.Fatal(err)
		}
		replay, err := service.CreatePending(f.ctx, c.user, "original-key", c.request)
		if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Order, order) {
			t.Fatal("same-key replay read mutable source data")
		}
		for _, change := range []func(*checkout.Request){func(r *checkout.Request) { r.CartVersion++ }, func(r *checkout.Request) { r.PaymentScenario = "reject" }, func(r *checkout.Request) { r.ShippingAddressID = checkoutID(t) }} {
			request := c.request
			change(&request)
			if _, err := service.CreatePending(f.ctx, c.user, "original-key", request); !errors.Is(err, checkout.ErrIdempotencyConflict) {
				t.Fatalf("changed intent did not conflict: %v", err)
			}
		}
		if _, err := service.CreatePending(f.ctx, c.user, "new-key", c.request); !errors.Is(err, checkout.ErrStaleCart) {
			t.Fatalf("stale cart accepted: %v", err)
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("same key concurrent and customer scoped", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 100, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		calls := make([]checkoutCall, 20)
		for i := range calls {
			calls[i] = checkoutCall{c, "shared-key"}
		}
		results, failures := concurrentCheckouts(t, f, calls)
		created := 0
		id := ""
		for i, result := range results {
			if failures[i] != nil {
				t.Fatalf("same key request: %v", failures[i])
			}
			if id == "" {
				id = result.Order.ID
			}
			if result.Order.ID != id {
				t.Fatal("duplicate key created another order")
			}
			if !result.Replayed {
				created++
			}
		}
		if created != 1 || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatal("exactly one new checkout required")
		}
		other := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		next, err := checkout.NewService(f.pool).CreatePending(f.ctx, other.user, "shared-key", other.request)
		if err != nil || next.Replayed || next.Order.ID == id {
			t.Fatal("key leaked across customers")
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("same key changed concurrent intent", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		changed := c
		changed.request.PaymentScenario = "reject"
		results, failures := concurrentCheckouts(t, f, []checkoutCall{{c, "key"}, {changed, "key"}})
		created, conflicts := 0, 0
		for i, err := range failures {
			if err == nil && !results[i].Replayed {
				created++
			} else if errors.Is(err, checkout.ErrIdempotencyConflict) {
				conflicts++
			} else {
				t.Fatalf("unexpected same-key result: %v", err)
			}
		}
		if created != 1 || conflicts != 1 {
			t.Fatal("conflicting intents were not serialized")
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("different keys same cart version", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		results, failures := concurrentCheckouts(t, f, []checkoutCall{{c, "one"}, {c, "two"}})
		created, stale := 0, 0
		for i, err := range failures {
			if err == nil && !results[i].Replayed {
				created++
			} else if errors.Is(err, checkout.ErrStaleCart) {
				stale++
			} else {
				t.Fatalf("unexpected different-key result: %v", err)
			}
		}
		if created != 1 || stale != 1 || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatal("one cart snapshot created multiple orders")
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("last unit 100 customers", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 1, 100)
		calls := make([]checkoutCall, 100)
		for i := range calls {
			calls[i] = checkoutCall{seedCheckoutCustomer(t, f, checkoutLine{product, 1}), fmt.Sprintf("key-%d", i)}
		}
		results, failures := concurrentCheckouts(t, f, calls)
		created, unavailable := 0, 0
		for i, err := range failures {
			if err == nil && !results[i].Replayed {
				created++
			} else if errors.Is(err, checkout.ErrInsufficientInventory) {
				unavailable++
			} else {
				t.Fatalf("unexpected contention result %d: %v", i, err)
			}
		}
		if created != 1 || unavailable != 99 || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatalf("last unit: created=%d conflicts=%d", created, unavailable)
		}
		var unchanged int
		if err := f.migrator.QueryRow(f.ctx, `SELECT count(*) FROM carts WHERE version=1`).Scan(&unchanged); err != nil || unchanged != 99 {
			t.Fatal("losing checkouts consumed carts")
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("opposite cart insertion order", func(t *testing.T) {
		f := newTestDatabase(t)
		a, b := seedCheckoutProduct(t, f, 10, 100), seedCheckoutProduct(t, f, 10, 200)
		one := seedCheckoutCustomer(t, f, checkoutLine{a, 1}, checkoutLine{b, 1})
		two := seedCheckoutCustomer(t, f, checkoutLine{b, 1}, checkoutLine{a, 1})
		results, failures := concurrentCheckouts(t, f, []checkoutCall{{one, "one"}, {two, "two"}})
		for i, err := range failures {
			if err != nil || len(results[i].Order.Items) != 2 || results[i].Order.TotalCents != 300 {
				t.Fatalf("ordered multi-product checkout failed: %v", err)
			}
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("checkout versus cart edit", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		start := make(chan struct{})
		var group sync.WaitGroup
		var result checkout.Result
		var checkoutError, cartError error
		group.Add(2)
		go func() {
			defer group.Done()
			<-start
			result, checkoutError = checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "key", c.request)
		}()
		go func() {
			defer group.Done()
			<-start
			_, cartError = commerce.NewService(f.pool).AddCartItem(f.ctx, c.user, product, 1)
		}()
		close(start)
		group.Wait()
		if cartError != nil {
			t.Fatal(cartError)
		}
		cart, err := commerce.NewService(f.pool).GetCart(f.ctx, c.user)
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case checkoutError == nil:
			if len(result.Order.Items) != 1 || result.Order.Items[0].Quantity != 1 || cart.Version != 3 || len(cart.Items) != 1 || cart.Items[0].Quantity != 1 {
				t.Fatal("cart edit leaked into checkout snapshot")
			}
		case errors.Is(checkoutError, checkout.ErrStaleCart):
			if cart.Version != 2 || len(cart.Items) != 1 || cart.Items[0].Quantity != 2 || checkoutCounts(t, f) != [6]int{} {
				t.Fatal("stale checkout changed cart/order")
			}
		default:
			t.Fatalf("unexpected checkout/cart race: %v", checkoutError)
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("partial reservation failure rolls back", func(t *testing.T) {
		f := newTestDatabase(t)
		a, b := seedCheckoutProduct(t, f, 10, 100), seedCheckoutProduct(t, f, 10, 100)
		// Fail the second UUID after the first stock hold has already succeeded.
		first, second := a, b
		if first > second {
			first, second = second, first
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory SET quantity_on_hand=0 WHERE product_id=$1`, second); err != nil {
			t.Fatal(err)
		}
		c := seedCheckoutCustomer(t, f, checkoutLine{first, 1}, checkoutLine{second, 1})
		if _, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "key", c.request); !errors.Is(err, checkout.ErrInsufficientInventory) {
			t.Fatalf("expected stock conflict: %v", err)
		}
		assertCheckoutRolledBack(t, f, c)
		var items int
		if err := f.migrator.QueryRow(f.ctx, `SELECT count(*) FROM cart_items WHERE cart_id=$1`, c.cart).Scan(&items); err != nil || items != 2 {
			t.Fatal("failed hold changed cart items")
		}
	})

	for _, failure := range []struct{ name, table, operation string }{{"late idempotency insert", "checkout_idempotency", "INSERT"}, {"cart version after clear", "carts", "UPDATE"}} {
		t.Run("rollback "+failure.name, func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 10, 100)
			c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
			statement := fmt.Sprintf(`CREATE FUNCTION abort_checkout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected late T1 failure'; END $$; CREATE TRIGGER abort_checkout BEFORE %s ON %s FOR EACH ROW EXECUTE FUNCTION abort_checkout();`, failure.operation, failure.table)
			if _, err := f.migrator.Exec(f.ctx, statement); err != nil {
				t.Fatal(err)
			}
			if _, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "key", c.request); err == nil || errors.Is(err, checkout.ErrOutcomeUncertain) {
				t.Fatalf("late failure did not acknowledge rollback: %v", err)
			}
			assertCheckoutRolledBack(t, f, c)
			var items int
			if err := f.migrator.QueryRow(f.ctx, `SELECT count(*) FROM cart_items WHERE cart_id=$1`, c.cart).Scan(&items); err != nil || items != 1 {
				t.Fatal("rollback failed to restore consumed cart item")
			}
		})
	}

	t.Run("validation ownership and bounds", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		other := seedCheckoutCustomer(t, f)
		service := checkout.NewService(f.pool)
		request := c.request
		request.ShippingAddressID = other.address
		if _, err := service.CreatePending(f.ctx, c.user, "key", request); !errors.Is(err, checkout.ErrAddressNotFound) {
			t.Fatalf("foreign address accepted: %v", err)
		}
		if _, err := service.CreatePending(f.ctx, other.user, "empty", other.request); !errors.Is(err, checkout.ErrEmptyCart) {
			t.Fatalf("empty cart accepted: %v", err)
		}
		if _, err := service.CreatePending(f.ctx, checkoutID(t), "key", c.request); !errors.Is(err, checkout.ErrUnauthorized) {
			t.Fatalf("unknown principal accepted: %v", err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET is_active=false WHERE id=$1`, other.user); err != nil {
			t.Fatal(err)
		}
		if _, err := service.CreatePending(f.ctx, other.user, "key", other.request); !errors.Is(err, checkout.ErrUnauthorized) {
			t.Fatalf("inactive principal accepted: %v", err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE products SET is_active=false WHERE id=$1`, product); err != nil {
			t.Fatal(err)
		}
		if _, err := service.CreatePending(f.ctx, c.user, "key", c.request); !errors.Is(err, checkout.ErrProductUnavailable) {
			t.Fatalf("inactive product accepted: %v", err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE products SET is_active=true,unit_price_cents=1000000000001 WHERE id=$1`, product); err != nil {
			t.Fatal(err)
		}
		if _, err := service.CreatePending(f.ctx, c.user, "key", c.request); !errors.Is(err, checkout.ErrInvalidTotal) {
			t.Fatalf("oversized price accepted: %v", err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE carts SET version=$2 WHERE id=$1`, c.cart, commerce.MaxCartVersion); err != nil {
			t.Fatal(err)
		}
		request = c.request
		request.CartVersion = commerce.MaxCartVersion
		if _, err := service.CreatePending(f.ctx, c.user, "key", request); !errors.Is(err, checkout.ErrVersionExhausted) {
			t.Fatalf("exhausted version accepted: %v", err)
		}
		if checkoutCounts(t, f) != [6]int{} {
			t.Fatal("rejected inputs created order rows")
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("money multiplication and subtotal limits", func(t *testing.T) {
		f := newTestDatabase(t)
		a, b := seedCheckoutProduct(t, f, 10, commerce.MaxPrice), seedCheckoutProduct(t, f, 10, 1)
		c := seedCheckoutCustomer(t, f, checkoutLine{a, 2})
		service := checkout.NewService(f.pool)
		if _, err := service.CreatePending(f.ctx, c.user, "key", c.request); !errors.Is(err, checkout.ErrInvalidTotal) {
			t.Fatal("line multiplication limit not enforced")
		}
		assertCheckoutRolledBack(t, f, c)
		if _, err := f.migrator.Exec(f.ctx, `UPDATE cart_items SET quantity=1 WHERE cart_id=$1`, c.cart); err != nil {
			t.Fatal(err)
		}
		if _, err := f.migrator.Exec(f.ctx, `INSERT INTO cart_items(id,cart_id,product_id,quantity) VALUES($1,$2,$3,1)`, checkoutID(t), c.cart, b); err != nil {
			t.Fatal(err)
		}
		if _, err := service.CreatePending(f.ctx, c.user, "key", c.request); !errors.Is(err, checkout.ErrInvalidTotal) {
			t.Fatal("subtotal limit not enforced")
		}
		assertCheckoutRolledBack(t, f, c)
		if _, err := f.migrator.Exec(f.ctx, `DELETE FROM cart_items WHERE cart_id=$1 AND product_id=$2`, c.cart, b); err != nil {
			t.Fatal(err)
		}
		result, err := service.CreatePending(f.ctx, c.user, "key", c.request)
		if err != nil || result.Order.TotalCents != commerce.MaxPrice {
			t.Fatalf("maximum safe total rejected: %v", err)
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("unmounted routes and snapshots immutable to runtime", func(t *testing.T) {
		f := newTestDatabase(t)
		service, err := auth.NewService(f.pool, []byte(strings.Repeat("test-key", 4)), time.Now)
		if err != nil {
			t.Fatal(err)
		}
		authHTTP := auth.NewHandler(service, auth.HTTPOptions{Origin: authTestOrigin})
		commerceHTTP := commerce.NewHandler(commerce.NewService(f.pool), authHTTP.Authenticate)
		server := httpserver.New("127.0.0.1:8080", func(context.Context) error { return nil }, slog.New(slog.NewTextHandler(io.Discard, nil)), authHTTP.RoutesWith(commerceHTTP.Routes))
		for _, path := range []string{"/api/v1/checkout", "/api/v1/orders"} {
			w := httptest.NewRecorder()
			server.Handler.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader(`{}`)))
			if w.Code != 404 && w.Code != 405 {
				t.Fatalf("premature HTTP exposure at %s: %d", path, w.Code)
			}
		}
		for _, sql := range []string{`UPDATE orders SET total_cents=0`, `UPDATE order_items SET sku_snapshot='changed'`, `UPDATE payment_attempts SET scenario='reject'`, `UPDATE inventory_reservations SET quantity=1`, `DELETE FROM checkout_idempotency`, `DELETE FROM order_status_history`} {
			_, err := f.pool.Exec(f.ctx, sql)
			var pgError *pgconn.PgError
			if !errors.As(err, &pgError) || pgError.Code != "42501" {
				t.Fatalf("runtime mutated immutable/settlement state: %v", err)
			}
		}
		// JSON snapshots must contain shipping fields, never saved-address IDs.
		product := seedCheckoutProduct(t, f, 1, 0)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		result, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "key", c.request)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(result.Order.ShippingAddress)
		if err != nil || strings.Contains(string(data), c.address) {
			t.Fatal("address identity leaked into shipping snapshot")
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("maximum cart zero prices and quantity bounds", func(t *testing.T) {
		f := newTestDatabase(t)
		lines := make([]checkoutLine, 101)
		for i := range lines {
			lines[i] = checkoutLine{seedCheckoutProduct(t, f, 10000, 0), 10000}
		}
		c := seedCheckoutCustomer(t, f, lines...)
		service := checkout.NewService(f.pool)
		if _, err := service.CreatePending(f.ctx, c.user, "large-cart", c.request); !errors.Is(err, checkout.ErrInvalidInput) {
			t.Fatalf("101-line cart accepted: %v", err)
		}
		assertCheckoutRolledBack(t, f, c)
		if _, err := f.migrator.Exec(f.ctx, `DELETE FROM cart_items WHERE cart_id=$1 AND product_id=$2`, c.cart, lines[100].product); err != nil {
			t.Fatal(err)
		}
		result, err := service.CreatePending(f.ctx, c.user, "large-cart", c.request)
		if err != nil || result.Order.TotalCents != 0 || len(result.Order.Items) != 100 || checkoutCounts(t, f) != [6]int{1, 100, 100, 1, 1, 1} {
			t.Fatalf("100-line zero-price boundary failed: %v", err)
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("replay reads current durable state without processing", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		service := checkout.NewService(f.pool)
		created, err := service.CreatePending(f.ctx, c.user, "state-key", c.request)
		if err != nil {
			t.Fatal(err)
		}
		// Operator-prepared future state tests reads only, not payment execution.
		if _, err := f.migrator.Exec(f.ctx, `UPDATE payment_attempts SET status='processing',started_at=clock_timestamp() WHERE order_id=$1`, created.Order.ID); err != nil {
			t.Fatal(err)
		}
		replay, err := service.CreatePending(f.ctx, c.user, "state-key", c.request)
		if err != nil || !replay.Replayed || replay.Order.Payment.Status != "processing" || replay.Order.Status != "pending_payment" {
			t.Fatalf("replay did not read current state: %v", err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE orders SET status='confirmed' WHERE id=$1`, created.Order.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.CreatePending(f.ctx, c.user, "state-key", c.request); !errors.Is(err, checkout.ErrIntegrity) {
			t.Fatalf("inconsistent terminal pair was accepted: %v", err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE orders SET status='pending_payment' WHERE id=$1`, created.Order.ID); err != nil {
			t.Fatal(err)
		}
		if checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatal("replay changed durable rows")
		}
		assertCheckoutIntegrity(t, f)
	})
}
