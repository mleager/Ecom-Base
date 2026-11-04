//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type orderLogs struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (logs *orderLogs) Write(data []byte) (int, error) {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.buffer.Write(data)
}
func (logs *orderLogs) String() string {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.buffer.String()
}

type paymentAPI struct {
	api     authAPI
	service *checkout.Service
	logs    *orderLogs
	secret  []byte
}

func newPaymentAPI(t *testing.T, f *testDatabase, pool *pgxpool.Pool, simulator checkout.Simulator) paymentAPI {
	t.Helper()
	secret := []byte(strings.Repeat("test-key", 4))
	logs := &orderLogs{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	authService, err := auth.NewService(f.pool, secret, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	authHTTP := auth.NewHandler(authService, auth.HTTPOptions{Origin: authTestOrigin})
	service := checkout.NewService(pool)
	if simulator != nil {
		service, err = checkout.NewServiceWithSimulator(pool, simulator)
		if err != nil {
			t.Fatal(err)
		}
	}
	commerceHTTP := commerce.NewHandler(commerce.NewService(f.pool), authHTTP.Authenticate)
	checkoutHTTP := checkout.NewHandler(service, authHTTP.Authenticate, logger)
	server := httpserver.New("127.0.0.1:8080", func(ctx context.Context) error { return database.Ready(ctx, f.pool) }, logger, authHTTP.RoutesWith(commerceHTTP.Routes, checkoutHTTP.Routes))
	httpServer := httptest.NewServer(server.Handler)
	t.Cleanup(httpServer.Close)
	return paymentAPI{authAPI{httpServer}, service, logs, secret}
}

func orderDo(api authAPI, method, path, body, token string, keys []string) (authResponse, error) {
	request, err := http.NewRequest(method, api.server.URL+path, strings.NewReader(body))
	if err != nil {
		return authResponse{}, err
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for _, key := range keys {
		request.Header.Add("Idempotency-Key", key)
	}
	response, err := api.server.Client().Do(request)
	if err != nil {
		return authResponse{}, err
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(response.Body)
	return authResponse{response.StatusCode, data, response.Header, response.Cookies()}, err
}

func orderRequest(t *testing.T, api authAPI, method, path, body, token string, keys []string, status int) authResponse {
	t.Helper()
	response, err := orderDo(api, method, path, body, token, keys)
	if err != nil || response.status != status {
		t.Fatalf("%s %s status=%d want=%d err=%v body=%s", method, path, response.status, status, err, response.body)
	}
	if response.headers.Get("Cache-Control") != "no-store" {
		t.Fatal("order response permits caching")
	}
	return response
}

func requestJSON(t *testing.T, input checkout.Request) string {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func httpCustomer(t *testing.T, f *testDatabase, api authAPI, email, product string) (checkoutCustomer, string) {
	t.Helper()
	user := decodeResponse[auth.User](t, api.request(t, "POST", "/api/v1/auth/register", registrationBody(email), "", nil, false, 201))
	tokens, _ := decodeTokens(t, api.request(t, "POST", "/api/v1/auth/login", credentialsBody(email, authTestPassword), "", nil, true, 200))
	address := decodeResponse[commerce.Address](t, api.request(t, "POST", "/api/v1/users/me/addresses", `{"recipient_name":"Sensitive Recipient","line_1":"123 Private Shipping Road","city":"Portland","region":"OR","postal_code":"97201"}`, tokens.AccessToken, nil, false, 201))
	cart := decodeResponse[commerce.Cart](t, api.request(t, "POST", "/api/v1/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, product), tokens.AccessToken, nil, false, 200))
	return checkoutCustomer{user: user.ID, cart: cart.ID, address: address.ID, request: checkout.Request{CartVersion: cart.Version, ShippingAddressID: address.ID, PaymentScenario: "accept"}}, tokens.AccessToken
}

func TestOrderHTTP(t *testing.T) {
	t.Run("accepted declined replay and owned reads", func(t *testing.T) {
		f := newTestDatabase(t)
		api := newPaymentAPI(t, f, f.pool, nil)
		product := seedCheckoutProduct(t, f, 5, 1234)
		customer, token := httpCustomer(t, f, api.api, "orders@example.com", product)
		response := orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, customer.request), token, []string{"accepted"}, 201)
		order := decodeResponse[checkout.Order](t, response)
		if order.Status != "confirmed" || order.Payment.Status != "succeeded" || order.TotalCents != 1234 || len(order.Items) != 1 || order.Items[0].Quantity != 1 || order.CreatedAt.IsZero() {
			t.Fatal("accepted order contract mismatch")
		}
		assertOrderState(t, f, order.ID, "confirmed", "succeeded", "consumed", 2)
		assertStock(t, f, product, 4, 0)
		path := "/api/v1/orders/" + order.ID
		read := decodeResponse[checkout.Order](t, api.api.request(t, "GET", path, "", token, nil, false, 200))
		if read.ID != order.ID || read.Payment.Status != "succeeded" {
			t.Fatal("order read contract mismatch")
		}
		payments := decodeResponse[[]checkout.Payment](t, api.api.request(t, "GET", path+"/payments", "", token, nil, false, 200))
		if len(payments) != 1 || payments[0].ID != order.Payment.ID || payments[0].Status != "succeeded" {
			t.Fatal("payment history contract mismatch")
		}
		orderRequest(t, api.api, "POST", path+"/cancel", "", token, nil, 409)
		if _, err := f.migrator.Exec(f.ctx, `DELETE FROM addresses WHERE id=$1`, customer.address); err != nil {
			t.Fatal(err)
		}
		replay := decodeResponse[checkout.Order](t, orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, customer.request), token, []string{"accepted"}, 200))
		if replay.ID != order.ID || replay.Status != "confirmed" {
			t.Fatal("HTTP retry did not retain result after source deletion")
		}
		changed := customer.request
		changed.PaymentScenario = "reject"
		orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, changed), token, []string{"accepted"}, 409)
		// Another customer exercises a real rejected checkout, still a durable 201.
		other, otherToken := httpCustomer(t, f, api.api, "declined@example.com", product)
		other.request.PaymentScenario = "reject"
		declined := decodeResponse[checkout.Order](t, orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, other.request), otherToken, []string{"declined"}, 201))
		if declined.Status != "payment_failed" || declined.Payment.FailureCode == nil || *declined.Payment.FailureCode != "simulated_decline" {
			t.Fatal("decline status/code mismatch")
		}
		assertStock(t, f, product, 4, 0)
		for _, suffix := range []string{"", "/payments"} {
			api.api.request(t, "GET", path+suffix, "", otherToken, nil, false, 404)
		}
		orderRequest(t, api.api, "POST", path+"/cancel", "", otherToken, nil, 404)
		owned := decodeResponse[[]checkout.Order](t, api.api.request(t, "GET", "/api/v1/orders", "", otherToken, nil, false, 200))
		if len(owned) != 1 || owned[0].ID != declined.ID {
			t.Fatal("list leaked another customer's order")
		}
		for _, query := range []string{"limit=0", "offset=-1", "limit=101"} {
			api.api.request(t, "GET", "/api/v1/orders?"+query, "", token, nil, false, 422)
		}
		for _, query := range []string{"limit=1.5", "limit=1&limit=2", "unknown=1"} {
			api.api.request(t, "GET", "/api/v1/orders?"+query, "", token, nil, false, 400)
		}
		if list := decodeResponse[[]checkout.Order](t, api.api.request(t, "GET", "/api/v1/orders?offset=2147483648", "", token, nil, false, 200)); list == nil || len(list) != 0 {
			t.Fatal("empty page must be []")
		}
		api.api.request(t, "GET", "/api/v1/orders/bad", "", token, nil, false, 400)
		api.api.request(t, "GET", "/api/v1/orders/"+checkoutID(t), "", token, nil, false, 404)
		for _, private := range []string{token, otherToken, "123 Private Shipping Road", "Sensitive Recipient", "simulator_reference", "test-key"} {
			if strings.Contains(api.logs.String(), private) {
				t.Fatal("logs exposed private order/auth material")
			}
		}
	})

	t.Run("strict input auth and cancellation", func(t *testing.T) {
		f := newTestDatabase(t)
		api := newPaymentAPI(t, f, f.pool, nil)
		product := seedCheckoutProduct(t, f, 5, 100)
		customer, token := httpCustomer(t, f, api.api, "inputs@example.com", product)
		body := requestJSON(t, customer.request)
		orderRequest(t, api.api, "POST", "/api/v1/checkout", body, "", []string{"key"}, 401)
		api.api.request(t, "GET", "/api/v1/orders", "", "", nil, false, 401)
		for _, keys := range [][]string{nil, {""}, {"one", "two"}, {"a b"}, {strings.Repeat("a", 129)}} {
			orderRequest(t, api.api, "POST", "/api/v1/checkout", body, token, keys, 400)
		}
		for _, input := range []string{`{}`, `{"cart_version":null,"shipping_address_id":"` + customer.address + `","payment_scenario":"accept"}`, strings.TrimSuffix(body, "}") + `,"interrupt_after_T1":true}`, strings.TrimSuffix(body, "}") + `,"user_id":"` + customer.user + `"}`, strings.Replace(body, `"cart_version":2`, `"cart_version":1.5`, 1), body + body} {
			orderRequest(t, api.api, "POST", "/api/v1/checkout", input, token, []string{"key"}, 400)
		}
		for _, change := range []func(*checkout.Request){func(r *checkout.Request) { r.CartVersion = 0 }, func(r *checkout.Request) { r.PaymentScenario = "unknown" }} {
			input := customer.request
			change(&input)
			orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, input), token, []string{"key"}, 422)
		}
		input := customer.request
		input.ShippingAddressID = "bad"
		orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, input), token, []string{"key"}, 400)
		input = customer.request
		input.ShippingAddressID = checkoutID(t)
		orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, input), token, []string{"key"}, 404)
		orderRequest(t, api.api, "POST", "/api/v1/checkout", `{"large":"`+strings.Repeat("a", 65<<10)+`"}`, token, []string{"key"}, 413)
		created, err := api.service.CreatePending(f.ctx, customer.user, "pending", customer.request)
		if err != nil {
			t.Fatal(err)
		}
		path := "/api/v1/orders/" + created.Order.ID + "/cancel"
		orderRequest(t, api.api, "POST", path, `{"force":true}`, token, nil, 400)
		orderRequest(t, api.api, "POST", path, strings.Repeat("a", 65<<10), token, nil, 413)
		cancelled := decodeResponse[checkout.Order](t, orderRequest(t, api.api, "POST", path, "", token, nil, 200))
		if cancelled.Status != "cancelled" || cancelled.Payment.Status != "cancelled" {
			t.Fatal("cancellation contract mismatch")
		}
		orderRequest(t, api.api, "POST", path, "", token, nil, 200)
		assertOrderState(t, f, created.Order.ID, "cancelled", "cancelled", "released", 2)
		api.api.request(t, "GET", "/api/v1/orders/"+created.Order.ID, "", "", nil, false, 401)
	})

	t.Run("interruption returns 202 and replay only reads", func(t *testing.T) {
		f := newTestDatabase(t)
		var calls atomic.Int32
		api := newPaymentAPI(t, f, f.pool, simulatorFunc(func(context.Context, checkout.Attempt) (checkout.Decision, error) {
			calls.Add(1)
			return "", errors.New("private simulator exception")
		}))
		product := seedCheckoutProduct(t, f, 5, 100)
		customer, token := httpCustomer(t, f, api.api, "interrupted@example.com", product)
		order := decodeResponse[checkout.Order](t, orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, customer.request), token, []string{"interrupted"}, 202))
		if order.Status != "pending_payment" || order.Payment.Status != "processing" {
			t.Fatal("202 did not reference known pending order")
		}
		for range 3 {
			api.api.request(t, "GET", "/api/v1/orders/"+order.ID, "", token, nil, false, 200)
			orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, customer.request), token, []string{"interrupted"}, 200)
		}
		orderRequest(t, api.api, "POST", "/api/v1/orders/"+order.ID+"/cancel", "", token, nil, 409)
		if calls.Load() != 1 {
			t.Fatal("polling/retry resumed simulator")
		}
		assertStock(t, f, product, 5, 1)
		if strings.Contains(api.logs.String(), "private simulator exception") {
			t.Fatal("logs leaked raw simulator exception")
		}
	})

	t.Run("simulator holds no transaction and pending is observable", func(t *testing.T) {
		f := newTestDatabase(t)
		entered := make(chan struct{})
		release := make(chan struct{})
		var once sync.Once
		api := newPaymentAPI(t, f, f.pool, simulatorFunc(func(ctx context.Context, attempt checkout.Attempt) (checkout.Decision, error) {
			close(entered)
			select {
			case <-release:
				return (checkout.LocalSimulator{}).Evaluate(ctx, attempt)
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}))
		t.Cleanup(func() { once.Do(func() { close(release) }) })
		product := seedCheckoutProduct(t, f, 5, 100)
		customer, token := httpCustomer(t, f, api.api, "observable@example.com", product)
		responses := make(chan authResponse, 1)
		failures := make(chan error, 1)
		body := requestJSON(t, customer.request)
		go func() {
			response, err := orderDo(api.api, "POST", "/api/v1/checkout", body, token, []string{"observable"})
			responses <- response
			failures <- err
		}()
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("simulator never entered")
		}
		if f.pool.Stat().AcquiredConns() != 0 {
			t.Fatal("processing retained database connection")
		}
		orders := decodeResponse[[]checkout.Order](t, api.api.request(t, "GET", "/api/v1/orders", "", token, nil, false, 200))
		if len(orders) != 1 || orders[0].Payment.Status != "processing" {
			t.Fatal("committed processing state is not observable")
		}
		orderRequest(t, api.api, "POST", "/api/v1/orders/"+orders[0].ID+"/cancel", "", token, nil, 409)
		orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, customer.request), token, []string{"observable"}, 200)
		once.Do(func() { close(release) })
		response := <-responses
		if err := <-failures; err != nil || response.status != 201 {
			t.Fatalf("original processing failed: %v status=%d", err, response.status)
		}
		assertOrderState(t, f, orders[0].ID, "confirmed", "succeeded", "consumed", 2)
	})

	t.Run("pagination ties have stable descending IDs", func(t *testing.T) {
		f := newTestDatabase(t)
		api := newPaymentAPI(t, f, f.pool, nil)
		product := seedCheckoutProduct(t, f, 5, 100)
		customer, token := httpCustomer(t, f, api.api, "pages@example.com", product)
		ids := make([]string, 0, 3)
		for i := range 3 {
			order := decodeResponse[checkout.Order](t, orderRequest(t, api.api, "POST", "/api/v1/checkout", requestJSON(t, customer.request), token, []string{fmt.Sprintf("page-%d", i)}, 201))
			ids = append(ids, order.ID)
			if i < 2 {
				cart := decodeResponse[commerce.Cart](t, api.api.request(t, "POST", "/api/v1/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, product), token, nil, false, 200))
				customer.request.CartVersion = cart.Version
			}
		}
		stamp := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
		if _, err := f.migrator.Exec(f.ctx, `UPDATE orders SET created_at=$2,reservation_expires_at=$2::timestamptz+interval '15 minutes' WHERE user_id=$1`, customer.user, stamp); err != nil {
			t.Fatal(err)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory_reservations r SET expires_at=o.reservation_expires_at FROM order_items i JOIN orders o ON o.id=i.order_id WHERE r.order_item_id=i.id AND o.user_id=$1`, customer.user); err != nil {
			t.Fatal(err)
		}
		sort.Strings(ids)
		orders := decodeResponse[[]checkout.Order](t, api.api.request(t, "GET", "/api/v1/orders?limit=1&offset=1", "", token, nil, false, 200))
		if len(orders) != 1 || orders[0].ID != ids[1] {
			t.Fatal("tie pagination is not ordered by descending UUID")
		}
		orders = decodeResponse[[]checkout.Order](t, api.api.request(t, "GET", "/api/v1/orders", "", token, nil, false, 200))
		if len(orders) != 3 || orders[0].ID != ids[2] || orders[2].ID != ids[0] {
			t.Fatal("order list has unstable ties")
		}
		assertCheckoutIntegrity(t, f)
	})
}

// High-contention HTTP tests use explicit already-authenticated fixtures rather
// than weakening registration's hashing/rate limits or storing test passwords.
func checkoutBearer(t *testing.T, f *testDatabase, user string, secret []byte) string {
	t.Helper()
	session := checkoutID(t)
	now := time.Now().UTC().Truncate(time.Second)
	if _, err := f.migrator.Exec(f.ctx, `INSERT INTO user_sessions(id,user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,now()+interval '7 days')`, session, user, "test-verifier-"+session); err != nil {
		t.Fatal(err)
	}
	claims := jwt.MapClaims{"iss": "ecom", "aud": "ecom-api", "sub": user, "sid": session, "jti": checkoutID(t), "iat": now.Unix(), "nbf": now.Unix(), "exp": now.Add(15 * time.Minute).Unix()}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestOrderHTTPContention(t *testing.T) {
	f := newTestDatabase(t)
	api := newPaymentAPI(t, f, f.pool, nil)
	product := seedCheckoutProduct(t, f, 1, 100)
	const count = 100
	customers := make([]checkoutCustomer, count)
	tokens := make([]string, count)
	bodies := make([]string, count)
	for i := range count {
		customers[i] = seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		tokens[i] = checkoutBearer(t, f, customers[i].user, api.secret)
		bodies[i] = requestJSON(t, customers[i].request)
	}
	start := make(chan struct{})
	var group sync.WaitGroup
	responses := make([]authResponse, count)
	failures := make([]error, count)
	for i := range count {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			responses[i], failures[i] = orderDo(api.api, "POST", "/api/v1/checkout", bodies[i], tokens[i], []string{fmt.Sprintf("last-%d", i)})
		}()
	}
	close(start)
	group.Wait()
	created, conflicts := 0, 0
	for i, response := range responses {
		if failures[i] != nil {
			t.Fatal(failures[i])
		}
		switch response.status {
		case 201:
			created++
			if order := decodeResponse[checkout.Order](t, response); order.Status != "confirmed" {
				t.Fatal("winner not settled")
			}
		case 409:
			conflicts++
		default:
			t.Fatalf("unexpected contention status=%d body=%s", response.status, response.body)
		}
	}
	if created != 1 || conflicts != 99 {
		t.Fatalf("created=%d conflicts=%d", created, conflicts)
	}
	assertStock(t, f, product, 0, 0)
	assertCheckoutIntegrity(t, f)
}
