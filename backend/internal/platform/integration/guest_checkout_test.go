//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/email"
	"ecom/backend/internal/platform/httpserver"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func guestCheckoutAPI(t *testing.T, f *testDatabase, pool *pgxpool.Pool, sender email.Sender, simulator ...checkout.Simulator) authAPI {
	t.Helper()
	authentication, err := auth.NewService(f.pool, []byte(strings.Repeat("test-key", 4)), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	options := auth.HTTPOptions{Origin: authTestOrigin}
	a := auth.NewHandler(authentication, options)
	g := commerce.NewGuestHandler(commerce.NewService(f.pool), a.Authenticate, options)
	c := checkout.NewService(pool)
	if len(simulator) == 1 {
		c, err = checkout.NewServiceWithSimulator(pool, simulator[0])
		if err != nil {
			t.Fatal(err)
		}
	}
	user := checkout.NewHandler(c, a.Authenticate, logger)
	guest := checkout.NewGuestHandler(checkout.NewGuestService(c, sender, authTestOrigin), g, false)
	server := httptest.NewServer(httpserver.New("127.0.0.1:0", func(context.Context) error { return nil }, logger,
		a.RoutesWith(g.Routes, user.Routes, guest.Routes)).Handler)
	t.Cleanup(server.Close)
	return authAPI{server}
}

func TestGuestCheckoutInterruptedProcessing(t *testing.T) {
	f := newTestDatabase(t)
	var calls atomic.Int32
	api := guestCheckoutAPI(t, f, f.pool, email.Disabled{}, simulatorFunc(func(context.Context, checkout.Attempt) (checkout.Decision, error) {
		calls.Add(1)
		return "", errors.New("isolated processing interruption")
	}))
	product := seedCheckoutProduct(t, f, 10, 100)
	p := makeGuestPurchase(t, api, product, "accept", "guest@example.test")
	p.prepare(t, api, 201)
	order := decodeResponse[checkout.Order](t, p.place(t, api, 202))
	if order.Status != "pending_payment" || order.Payment.Status != "processing" {
		t.Fatal("interrupted payment did not retain its processing claim")
	}
	replayed := decodeResponse[checkout.Order](t, p.place(t, api, 200))
	guestCheckoutCall(t, api, "POST", "/orders/"+order.ID+"/cancel", "", "", 409, p.cookie)
	if calls.Load() != 1 || replayed.ID != order.ID || replayed.Payment.Status != "processing" {
		t.Fatal("replay restarted the simulator")
	}
}

func doGuestCheckout(api authAPI, method, path, body, key string, cookies ...*http.Cookie) (authResponse, error) {
	r, err := http.NewRequest(method, api.server.URL+"/api/v1/guest"+path, strings.NewReader(body))
	if err != nil {
		return authResponse{}, err
	}
	if method != http.MethodGet {
		r.Header.Set("Origin", authTestOrigin)
		r.Header.Set("X-CSRF-Protection", "1")
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	response, err := api.server.Client().Do(r)
	if err != nil {
		return authResponse{}, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	return authResponse{response.StatusCode, data, response.Header, response.Cookies()}, err
}

func guestCheckoutCall(t *testing.T, api authAPI, method, path, body, key string, want int, cookies ...*http.Cookie) authResponse {
	t.Helper()
	response, err := doGuestCheckout(api, method, path, body, key, cookies...)
	if err != nil || response.status != want || response.headers.Get("Cache-Control") != "no-store" {
		t.Fatalf("%s %s: status %d want %d, transport %v", method, path, response.status, want, err)
	}
	return response
}

type guestPurchase struct {
	intent, key, prep, submit string
	cookie                    *http.Cookie
}

func makeGuestPurchase(t *testing.T, api authAPI, product, scenario, contact string) guestPurchase {
	t.Helper()
	_, cookie := createGuest(t, api)
	return makeGuestPurchaseFor(t, api, cookie, product, scenario, contact)
}

func makeGuestPurchaseFor(t *testing.T, api authAPI, cookie *http.Cookie, product, scenario, contact string) guestPurchase {
	t.Helper()
	response := api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":2}`, product), "", cookie, true, 200)
	cart := decodeResponse[commerce.Cart](t, response)
	id, key := checkoutID(t), checkoutID(t)
	return guestPurchase{
		intent: id, key: key, cookie: cookie,
		prep: fmt.Sprintf(`{"id":%q,"cart_version":%d,"payment_scenario":%q,"contact_email":%q,"shipping_address":{"recipient_name":"Guest Buyer","line_1":"10 Main St","city":"Portland","region":"or","postal_code":"97201","country_code":"US"}}`,
			id, cart.Version, scenario, contact),
		submit: fmt.Sprintf(`{"checkout_intent_id":%q,"cart_version":%d,"payment_scenario":%q}`, id, cart.Version, scenario),
	}
}

func (p guestPurchase) prepare(t *testing.T, api authAPI, want int) authResponse {
	t.Helper()
	return guestCheckoutCall(t, api, "POST", "/checkout-intents", p.prep, p.key, want, p.cookie)
}

func (p guestPurchase) place(t *testing.T, api authAPI, want int) authResponse {
	t.Helper()
	return guestCheckoutCall(t, api, "POST", "/checkout", p.submit, p.key, want, p.cookie)
}

func TestGuestCheckoutSettlements(t *testing.T) {
	for _, tc := range []struct {
		scenario, orderState, paymentState, reservation string
		onHand                                          int
	}{{"accept", "confirmed", "succeeded", "consumed", 8}, {"reject", "payment_failed", "failed", "released", 10}} {
		t.Run(tc.scenario, func(t *testing.T) {
			f := newTestDatabase(t)
			api := guestCheckoutAPI(t, f, f.pool, email.Disabled{})
			product := seedCheckoutProduct(t, f, 10, 100)
			p := makeGuestPurchase(t, api, product, tc.scenario, " Guest@Example.test ")
			before := guestCart(t, api, p.cookie)
			if got := string(p.prepare(t, api, 201).body); !strings.Contains(got, `"contact_email":"guest@example.test"`) || !strings.Contains(got, `"region":"OR"`) {
				t.Fatal("preparation failed to canonicalize contact/shipping")
			}
			p.prepare(t, api, 200)
			guestCheckoutCall(t, api, "POST", "/checkout-intents", strings.Replace(p.prep, "10 Main St", "99 Main St", 1), p.key, 409, p.cookie)
			guestCheckoutCall(t, api, "POST", "/checkout-intents", strings.Replace(p.prep, `"city":"Portland"`, `"city":"Portland","city":"Seattle"`, 1), p.key, 400, p.cookie)
			guestCheckoutCall(t, api, "POST", "/checkout", strings.Replace(p.submit, tc.scenario, "unknown", 1), p.key, 422, p.cookie)
			if counts := checkoutCounts(t, f); counts != [6]int{} {
				t.Fatal("preparation created financial work")
			}
			if _, err := f.migrator.Exec(f.ctx, `UPDATE products SET unit_price_cents=120 WHERE id=$1`, product); err != nil {
				t.Fatal(err)
			}
			first := p.place(t, api, 201)
			order := decodeResponse[checkout.Order](t, first)
			if order.Status != tc.orderState || order.Payment.Status != tc.paymentState || order.TotalCents != 240 || order.ShippingAddress.Line1 != "10 Main St" || strings.Contains(string(first.body), "guest@example.test") {
				t.Fatal("incorrect order outcome or private snapshot exposure")
			}
			otherScenario := "reject"
			if tc.scenario == otherScenario {
				otherScenario = "accept"
			}
			guestCheckoutCall(t, api, "POST", "/checkout", strings.Replace(p.submit, tc.scenario, otherScenario, 1), p.key, 409, p.cookie)
			replayed := decodeResponse[checkout.Order](t, p.place(t, api, 200))
			if replayed.ID != order.ID || replayed.Status != order.Status {
				t.Fatal("same-key replay changed the order")
			}
			if cart := guestCart(t, api, p.cookie); len(cart.Items) != 0 || cart.Version != before.Version+1 {
				t.Fatal("T1 did not consume the cart exactly once")
			}
			var onHand, reserved, accounts, addresses int
			var state string
			err := f.migrator.QueryRow(f.ctx, `SELECT quantity_on_hand,quantity_reserved,(SELECT count(*) FROM users),
 (SELECT count(*) FROM addresses),(SELECT status FROM inventory_reservations) FROM inventory WHERE product_id=$1`, product).
				Scan(&onHand, &reserved, &accounts, &addresses, &state)
			if err != nil || onHand != tc.onHand || reserved != 0 || state != tc.reservation || accounts != 0 || addresses != 0 {
				t.Fatal("guest checkout violated stock or identity invariants")
			}
			assertCheckoutIntegrity(t, f)
			retire := guestCheckoutCall(t, api, "POST", "/checkout-intents/"+p.intent+"/retire", "", p.key, 200, p.cookie)
			if !strings.Contains(string(retire.body), order.ID) {
				t.Fatal("retirement lost known order")
			}
			guestCheckoutCall(t, api, "GET", "/orders?limit=1&offset=0", "", "", 200, p.cookie)
			guestCheckoutCall(t, api, "GET", "/orders/"+order.ID+"/payments", "", "", 200, p.cookie)
			guestCheckoutCall(t, api, "POST", "/orders/"+order.ID+"/cancel", "", "", 409, p.cookie)
			_, other := createGuest(t, api)
			guestCheckoutCall(t, api, "GET", "/orders/"+order.ID, "", "", 404, other)
			guestCheckoutCall(t, api, "GET", "/checkout-intents/"+p.intent, "", "", 404, other)
		})
	}
}

func TestGuestCheckoutFences(t *testing.T) {
	f := newTestDatabase(t)
	api := guestCheckoutAPI(t, f, f.pool, email.Disabled{})
	product := seedCheckoutProduct(t, f, 1, 100)
	p := makeGuestPurchase(t, api, product, "accept", "guest@example.test")
	guestCheckoutCall(t, api, "POST", "/checkout-intents/"+p.intent+"/retire", "", p.key, 200, p.cookie)
	p.prepare(t, api, 409)
	p.place(t, api, 409)
	p.intent, p.key = checkoutID(t), checkoutID(t)
	p.prep, p.submit = replaceGuestIntentID(t, p.prep, p.submit, p.intent)
	p.prepare(t, api, 201)
	p.place(t, api, 409)
	closed := guestCheckoutCall(t, api, "GET", "/checkout-intents/"+p.intent, "", "", 200, p.cookie)
	if !strings.Contains(string(closed.body), `"state":"rejected"`) || strings.Contains(string(closed.body), "10 Main St") {
		t.Fatal("business refusal was not fenced and scrubbed")
	}
	if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory SET quantity_on_hand=10 WHERE product_id=$1`, product); err != nil {
		t.Fatal(err)
	}
	p.place(t, api, 409)
	p.intent, p.key = checkoutID(t), checkoutID(t)
	p.prep, p.submit = replaceGuestIntentID(t, p.prep, p.submit, p.intent)
	p.prepare(t, api, 201)
	if _, err := f.migrator.Exec(f.ctx, `UPDATE guest_checkout_intents SET created_at=clock_timestamp()-interval '31 days',
 expires_at=clock_timestamp()-interval '1 day' WHERE id=$1`, p.intent); err != nil {
		t.Fatal(err)
	}
	p.place(t, api, 409)
	var state string
	var scrubbed bool
	if err := f.migrator.QueryRow(f.ctx, `SELECT state,contact_email IS NULL AND shipping_address IS NULL AND octet_length(contact_digest)=32 FROM guest_checkout_intents WHERE id=$1`, p.intent).Scan(&state, &scrubbed); err != nil || state != "expired" || !scrubbed {
		t.Fatal("expiry failed to preserve only the matching digest")
	}
	if counts := checkoutCounts(t, f); counts != [6]int{} {
		t.Fatal("closed intent produced financial work")
	}
}

func TestGuestCheckoutStockRaceAndOwnership(t *testing.T) {
	f := newTestDatabase(t)
	api := guestCheckoutAPI(t, f, f.pool, email.Disabled{})
	product := seedCheckoutProduct(t, f, 2, 100)
	first := makeGuestPurchase(t, api, product, "accept", "guest@example.test")
	second := makeGuestPurchase(t, api, product, "accept", "guest@example.test")
	first.prepare(t, api, 201)
	second.prepare(t, api, 201)
	var requests sync.WaitGroup
	var responses [2]authResponse
	var errs [2]error
	for i, p := range []guestPurchase{first, second} {
		requests.Go(func() {
			responses[i], errs[i] = doGuestCheckout(api, "POST", "/checkout", p.submit, p.key, p.cookie)
		})
	}
	requests.Wait()
	var order checkout.Order
	var winner, refusals int
	for i, response := range responses {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		switch response.status {
		case 201:
			order = decodeResponse[checkout.Order](t, response)
			winner = i
		case 409:
			refusals++
			if !strings.Contains(string(response.body), `"code":"insufficient_inventory"`) {
				t.Fatal("stock refusal lost its authoritative code")
			}
		default:
			t.Fatalf("unexpected stock race response %d", response.status)
		}
	}
	if order.Status != "confirmed" || refusals != 1 || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 2} {
		t.Fatal("stock race failed to preserve one committed graph")
	}
	assertCheckoutIntegrity(t, f)
	loser := []guestPurchase{second, first}[winner]
	var wrongOwner string
	if err := f.migrator.QueryRow(f.ctx, `SELECT guest_id FROM guest_checkout_intents WHERE id=$1`, loser.intent).Scan(&wrongOwner); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`UPDATE orders SET guest_id=$1 WHERE id=$2`,
		`UPDATE checkout_idempotency SET guest_id=$1 WHERE order_id=$2`,
	} {
		_, err := f.migrator.Exec(f.ctx, statement, wrongOwner, order.ID)
		var problem *pgconn.PgError
		if !errorsAsPG(err, &problem, "23503") {
			t.Fatal("database accepted cross-owner financial linkage")
		}
	}
	_, err := f.pool.Exec(f.ctx, `UPDATE orders SET contact_email='changed@example.test' WHERE id=$1`, order.ID)
	var problem *pgconn.PgError
	if !errorsAsPG(err, &problem, "42501") {
		t.Fatal("runtime may modify an immutable order contact")
	}
	_, source, _, _ := runtime.Caller(0)
	migration, err := os.ReadFile(filepath.Join(filepath.Dir(source), "../../../migrations/00013_guest_checkout.sql"))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := f.migrator.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	_, err = tx.Exec(f.ctx, strings.SplitN(string(migration), "-- +goose Down", 2)[1])
	if !errorsAsPG(err, &problem, "P0001") {
		t.Fatal("down migration did not protect guest orders")
	}
}

func replaceGuestIntentID(t *testing.T, prepare, submit, id string) (string, string) {
	t.Helper()
	replace := func(body, field string) string {
		var input map[string]json.RawMessage
		if err := json.Unmarshal([]byte(body), &input); err != nil {
			t.Fatal(err)
		}
		input[field] = json.RawMessage(fmt.Sprintf("%q", id))
		encoded, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	return replace(prepare, "id"), replace(submit, "checkout_intent_id")
}

func TestGuestCheckoutConcurrentAndLostCommit(t *testing.T) {
	for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter} {
		t.Run(fmt.Sprint(mode), func(t *testing.T) {
			f := newTestDatabase(t)
			api := guestCheckoutAPI(t, f, f.pool, email.Disabled{})
			product := seedCheckoutProduct(t, f, 20, 100)
			p := makeGuestPurchase(t, api, product, "reject", "guest@example.test")
			p.prepare(t, api, 201)
			pool, fault := newCommitFaultPool(t, f, mode)
			faultAPI := guestCheckoutAPI(t, f, pool, email.Disabled{})
			if mode == commitDropBefore {
				p.place(t, faultAPI, 503)
				if counts := checkoutCounts(t, f); counts != [6]int{} {
					t.Fatal("uncommitted guest order became visible")
				}
			} else {
				order := decodeResponse[checkout.Order](t, p.place(t, faultAPI, 200))
				if order.Status != "pending_payment" || order.Payment.Status != "pending" {
					t.Fatal("lost T1 acknowledgement resumed processing")
				}
			}
			awaitCommitFault(t, fault)
			var calls sync.WaitGroup
			var responses [2]authResponse
			var errs [2]error
			for i := range responses {
				calls.Go(func() {
					responses[i], errs[i] = doGuestCheckout(api, "POST", "/checkout", p.submit, p.key, p.cookie)
				})
			}
			calls.Wait()
			var orderID string
			for i, response := range responses {
				if errs[i] != nil || (response.status != 200 && response.status != 201) {
					t.Fatalf("concurrent guest checkout status %d", response.status)
				}
				order := decodeResponse[checkout.Order](t, response)
				if orderID != "" && orderID != order.ID {
					t.Fatal("concurrent replay produced another order")
				}
				orderID = order.ID
			}
			history := 1
			if mode == commitDropBefore {
				history = 2
			}
			if counts := checkoutCounts(t, f); counts != [6]int{1, 1, 1, 1, 1, history} {
				t.Fatal("guest financial graph duplicated or incomplete")
			}
			if mode == commitDropAfter {
				customer := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
				service := checkout.NewService(f.pool)
				userOrder, err := service.CreatePending(f.ctx, customer.user, "account-key", customer.request)
				if err != nil {
					t.Fatal(err)
				}
				expireRecoveryOrder(t, f, orderID, time.Now().Add(-time.Hour))
				expireRecoveryOrder(t, f, userOrder.Order.ID, time.Now().Add(-time.Hour))
				api.request(t, "DELETE", "/api/v1/guest/session", "", "", p.cookie, true, 204)
				report, err := service.Recover(f.ctx, 10, nil)
				if err != nil || report.Settled != 2 {
					t.Fatalf("mixed-owner operator recovery failed: %+v, %v", report, err)
				}
			}
			assertCheckoutIntegrity(t, f)
		})
	}
}
