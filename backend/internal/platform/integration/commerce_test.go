//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"

	"github.com/jackc/pgx/v5/pgconn"
)

func decodeResponse[T any](t *testing.T, response authResponse) T {
	t.Helper()
	var result T
	decoder := json.NewDecoder(bytes.NewReader(response.body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("invalid response JSON: %v", err)
	}
	return result
}

// Barrier-start requests use independent HTTP requests/connections and exercise
// the real runtime role. Results are checked after all goroutines have joined.
func concurrentRequests(t *testing.T, api authAPI, count int, method, path, body, token string, want int) []authResponse {
	t.Helper()
	start := make(chan struct{})
	responses := make([]authResponse, count)
	errors := make([]error, count)
	var group sync.WaitGroup
	for i := range count {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			responses[i], errors[i] = api.do(method, path, body, token, nil, false)
		}()
	}
	close(start)
	group.Wait()
	for i, response := range responses {
		if errors[i] != nil || response.status != want {
			t.Fatalf("concurrent request %d: status=%d want=%d error=%v body=%s", i, response.status, want, errors[i], response.body)
		}
	}
	return responses
}

func TestCommerce(t *testing.T) {
	f := newTestDatabase(t)
	service, err := auth.NewService(f.pool, []byte(strings.Repeat("test-key", 4)), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	authHTTP := auth.NewHandler(service, auth.HTTPOptions{Origin: authTestOrigin})
	commerceHTTP := commerce.NewHandler(commerce.NewService(f.pool), authHTTP.Authenticate)
	server := httpserver.New("127.0.0.1:8080", func(ctx context.Context) error { return database.Ready(ctx, f.pool) }, slog.New(slog.NewTextHandler(io.Discard, nil)), authHTTP.RoutesWith(commerceHTTP.Routes))
	httpServer := httptest.NewServer(server.Handler)
	t.Cleanup(httpServer.Close)
	api := authAPI{httpServer}
	register := func(email string) (auth.User, string) {
		t.Helper()
		user := decodeResponse[auth.User](t, api.request(t, "POST", "/api/v1/auth/register", registrationBody(email), "", nil, false, 201))
		tokens, _ := decodeTokens(t, api.request(t, "POST", "/api/v1/auth/login", credentialsBody(email, authTestPassword), "", nil, true, 200))
		return user, tokens.AccessToken
	}
	customer, token := register("commerce@example.com")
	_, other := register("other@example.com")
	adminUser, admin := register("admin@example.com")
	if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET role='admin' WHERE id=$1`, adminUser.ID); err != nil {
		t.Fatal(err)
	}
	productNumber := 0
	createProduct := func() commerce.Product {
		t.Helper()
		productNumber++
		body := fmt.Sprintf(`{"sku":"SKU-%d","name":"Product %03d","description":"Description","image_url":"https://example.com/p.png","unit_price_cents":1234}`, productNumber, productNumber)
		return decodeResponse[commerce.Product](t, api.request(t, "POST", "/api/v1/admin/products", body, admin, nil, false, 201))
	}
	getCart := func(bearer string) commerce.Cart {
		t.Helper()
		return decodeResponse[commerce.Cart](t, api.request(t, "GET", "/api/v1/cart", "", bearer, nil, false, 200))
	}
	clear := func() { t.Helper(); api.request(t, "DELETE", "/api/v1/cart/items", "", token, nil, false, 204) }
	add := func(product string, quantity int, bearer string, status int) authResponse {
		t.Helper()
		return api.request(t, "POST", "/api/v1/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":%d}`, product, quantity), bearer, nil, false, status)
	}

	t.Run("feature routes share the origin policy", func(t *testing.T) {
		response := api.request(t, "GET", "/api/v1/products", "", "", nil, true, 200)
		if response.headers.Get("Access-Control-Allow-Origin") != authTestOrigin || response.headers.Get("Access-Control-Allow-Credentials") != "true" {
			t.Fatal("feature route omitted credentialed origin policy")
		}
		request, err := http.NewRequest("GET", httpServer.URL+"/api/v1/products", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", "https://untrusted.example")
		denied, err := httpServer.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = denied.Body.Close() }()
		if denied.StatusCode != 403 || denied.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("feature route accepted untrusted origin")
		}
		request, err = http.NewRequest("OPTIONS", httpServer.URL+"/api/v1/users/me/addresses", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", authTestOrigin)
		request.Header.Set("Access-Control-Request-Method", "PATCH")
		request.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
		preflight, err := httpServer.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = preflight.Body.Close() }()
		if preflight.StatusCode != 204 || preflight.Header.Get("Access-Control-Allow-Origin") != authTestOrigin {
			t.Fatal("feature preflight requires authentication or omitted origin")
		}
	})

	t.Run("profile partial updates and strict input", func(t *testing.T) {
		response := api.request(t, "PATCH", "/api/v1/users/me", `{"first_name":" Updated "}`, token, nil, false, 200)
		user := decodeResponse[auth.User](t, response)
		if user.ID != customer.ID || user.FirstName != "Updated" || user.LastName != "Customer" || user.Role != "customer" || user.Email != customer.Email {
			t.Fatal("partial profile update overwrote protected/omitted fields")
		}
		for _, tc := range []struct {
			body   string
			status int
		}{
			{`{}`, 422}, {`{"first_name":" "}`, 422}, {`{"role":"admin"}`, 400}, {`{"email":"new@example.com"}`, 400},
			{`{"is_active":false}`, 400}, {`{"first_name":null}`, 400}, {`{"first_name":1}`, 400},
			{`{"first_name":"A","first_name":"B"}`, 400}, {`{"First_name":"A"}`, 400}, {`{} {}`, 400},
			{`{"first_name":"` + strings.Repeat("a", 65<<10) + `"}`, 413},
		} {
			api.request(t, "PATCH", "/api/v1/users/me", tc.body, token, nil, false, tc.status)
		}
		api.request(t, "PATCH", "/api/v1/users/me", `{"first_name":"A"}`, "", nil, false, 401)
		start := make(chan struct{})
		var group sync.WaitGroup
		failures := make(chan error, 2)
		for _, body := range []string{`{"first_name":"Concurrent"}`, `{"last_name":"Independent"}`} {
			group.Add(1)
			go func() {
				defer group.Done()
				<-start
				response, err := api.do("PATCH", "/api/v1/users/me", body, token, nil, false)
				if err != nil || response.status != 200 {
					failures <- fmt.Errorf("profile patch failed: %v status=%d", err, response.status)
				}
			}()
		}
		close(start)
		group.Wait()
		close(failures)
		for err := range failures {
			t.Fatal(err)
		}
		user = decodeResponse[auth.User](t, api.request(t, "GET", "/api/v1/users/me", "", token, nil, false, 200))
		if user.FirstName != "Concurrent" || user.LastName != "Independent" {
			t.Fatal("concurrent disjoint patches lost data")
		}
	})

	t.Run("saved addresses ownership and patch semantics", func(t *testing.T) {
		response := api.request(t, "GET", "/api/v1/users/me/addresses", "", token, nil, false, 200)
		if strings.TrimSpace(string(response.body)) != "[]" {
			t.Fatal("empty list must be an array")
		}
		body := `{"label":" Home ","recipient_name":" Test Customer ","line_1":" 1 Main St ","line_2":" Apt 2 ","city":" Portland ","region":"or","postal_code":"97201-1234"}`
		address := decodeResponse[commerce.Address](t, api.request(t, "POST", "/api/v1/users/me/addresses", body, token, nil, false, 201))
		if address.CountryCode != "US" || address.Region != "OR" || address.Label != "Home" || address.Line1 != "1 Main St" {
			t.Fatal("address normalization failed")
		}
		path := "/api/v1/users/me/addresses/" + address.ID
		api.request(t, "PATCH", path, `{"city":"Seattle"}`, other, nil, false, 404)
		api.request(t, "DELETE", path, "", other, nil, false, 404)
		if list := decodeResponse[[]commerce.Address](t, api.request(t, "GET", "/api/v1/users/me/addresses", "", other, nil, false, 200)); len(list) != 0 {
			t.Fatal("another user's address was listed")
		}
		patched := decodeResponse[commerce.Address](t, api.request(t, "PATCH", path, `{"label":"","line_2":"","city":"Seattle","region":"wa"}`, token, nil, false, 200))
		if patched.Label != "" || patched.Line2 != "" || patched.Line1 != address.Line1 || patched.Region != "WA" || patched.PostalCode != address.PostalCode {
			t.Fatal("patch lost omitted fields or failed to clear optional fields")
		}
		var cleared bool
		if err := f.migrator.QueryRow(f.ctx, `SELECT label IS NULL AND line_2 IS NULL FROM addresses WHERE id=$1`, address.ID).Scan(&cleared); err != nil || !cleared {
			t.Fatal("empty optional fields were not SQL NULL")
		}
		for _, tc := range []struct {
			method, path, body string
			status             int
		}{
			{"PATCH", path, `{}`, 422}, {"PATCH", path, `{"city":null}`, 400}, {"PATCH", path, `{"user_id":"` + adminUser.ID + `"}`, 400},
			{"PATCH", path, `{"country_code":"US"}`, 400}, {"PATCH", path, `{"region":"ZZ"}`, 422}, {"PATCH", path, `{"postal_code":"1234"}`, 422},
			{"POST", "/api/v1/users/me/addresses", strings.TrimSuffix(body, "}") + `,"country_code":"CA"}`, 422},
			{"POST", "/api/v1/users/me/addresses", `{"city":"Boston"}`, 400}, {"DELETE", "/api/v1/users/me/addresses/bad", "", 400},
		} {
			api.request(t, tc.method, tc.path, tc.body, token, nil, false, tc.status)
		}
		second := decodeResponse[commerce.Address](t, api.request(t, "POST", "/api/v1/users/me/addresses", body, token, nil, false, 201))
		list := decodeResponse[[]commerce.Address](t, api.request(t, "GET", "/api/v1/users/me/addresses", "", token, nil, false, 200))
		if len(list) != 2 || list[0].ID != address.ID || list[1].ID != second.ID {
			t.Fatal("address list ordering incorrect")
		}
		api.request(t, "DELETE", path, "", token, nil, false, 204)
		api.request(t, "DELETE", path, "", token, nil, false, 404)
	})

	t.Run("catalog admin policy and public contract", func(t *testing.T) {
		api.request(t, "POST", "/api/v1/admin/products", `{}`, "", nil, false, 401)
		api.request(t, "POST", "/api/v1/admin/products", `{}`, token, nil, false, 403)
		first, second := createProduct(), createProduct()
		if first.AvailableQuantity != 0 || !first.IsActive {
			t.Fatal("new product did not start active with empty inventory")
		}
		list := decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/products?limit=1&offset=1", "", "", nil, false, 200))
		if len(list) != 1 || list[0].ID != second.ID {
			t.Fatal("catalog pagination/order mismatch")
		}
		api.request(t, "GET", "/api/v1/products/"+first.ID, "", "", nil, false, 200)
		for _, tc := range []struct {
			query  string
			status int
		}{{"limit=0", 422}, {"limit=101", 422}, {"offset=-1", 422}, {"limit=1.5", 400}, {"limit=1&limit=2", 400}} {
			api.request(t, "GET", "/api/v1/products?"+tc.query, "", "", nil, false, tc.status)
		}
		if list := decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/products?offset=2147483648", "", "", nil, false, 200)); list == nil || len(list) != 0 {
			t.Fatal("large empty offset should return []")
		}
		api.request(t, "GET", "/api/v1/products/not-a-uuid", "", "", nil, false, 400)
		api.request(t, "GET", "/api/v1/products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "", "", nil, false, 404)
		api.request(t, "POST", "/api/v1/admin/products", fmt.Sprintf(`{"sku":%q,"name":"Duplicate","unit_price_cents":0}`, first.SKU), admin, nil, false, 409)
		api.request(t, "PATCH", "/api/v1/admin/products/"+second.ID, fmt.Sprintf(`{"sku":%q}`, first.SKU), admin, nil, false, 409)
		path := "/api/v1/admin/products/" + first.ID
		product := decodeResponse[commerce.Product](t, api.request(t, "PATCH", path, `{"unit_price_cents":0,"description":"","image_url":""}`, admin, nil, false, 200))
		if product.UnitPriceCents != 0 || product.Description != "" || product.ImageURL != "" || product.SKU != first.SKU || product.Name != first.Name {
			t.Fatal("product patch semantics failed")
		}
		var cleared bool
		if err := f.migrator.QueryRow(f.ctx, `SELECT description IS NULL AND image_url IS NULL FROM products WHERE id=$1`, first.ID).Scan(&cleared); err != nil || !cleared {
			t.Fatal("product optional text was not cleared to SQL NULL")
		}
		for _, tc := range []struct {
			body   string
			status int
		}{{`{}`, 422}, {`{"name":null}`, 400}, {`{"unit_price_cents":-1}`, 422}, {`{"unit_price_cents":1000000000001}`, 422}, {`{"unit_price_cents":1.5}`, 400}, {`{"image_url":"file:///private"}`, 422}, {`{"quantity_on_hand":10}`, 400}} {
			api.request(t, "PATCH", path, tc.body, admin, nil, false, tc.status)
		}
		api.request(t, "PATCH", path, `{"name":"Unauthorized"}`, token, nil, false, 403)
		api.request(t, "DELETE", path, "", token, nil, false, 403)
		api.request(t, "PATCH", path+"/inventory", `{"delta":1}`, token, nil, false, 403)
		api.request(t, "DELETE", path, "", admin, nil, false, 204)
		api.request(t, "GET", "/api/v1/products/"+first.ID, "", "", nil, false, 404)
		product = decodeResponse[commerce.Product](t, api.request(t, "PATCH", path, `{"is_active":true,"unit_price_cents":1000000000000}`, admin, nil, false, 200))
		if !product.IsActive || product.UnitPriceCents != commerce.MaxPrice {
			t.Fatal("reactivation/maximum price failed")
		}
		api.request(t, "PATCH", "/api/v1/admin/products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", `{"name":"Missing"}`, admin, nil, false, 404)
		api.request(t, "DELETE", "/api/v1/admin/products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "", admin, nil, false, 404)
	})

	t.Run("atomic product and inventory creation", func(t *testing.T) {
		_, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION fail_inventory_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected inventory failure'; END $$; CREATE TRIGGER fail_inventory BEFORE INSERT ON inventory FOR EACH ROW EXECUTE FUNCTION fail_inventory_insert();`)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER fail_inventory ON inventory; DROP FUNCTION fail_inventory_insert();`); err != nil {
				t.Error(err)
			}
		})
		response := api.request(t, "POST", "/api/v1/admin/products", `{"sku":"ROLLBACK","name":"Rollback","unit_price_cents":1}`, admin, nil, false, 500)
		if strings.Contains(string(response.body), "injected") {
			t.Fatal("SQL error leaked")
		}
		var count int
		if err := f.migrator.QueryRow(f.ctx, `SELECT count(*) FROM products WHERE sku='ROLLBACK'`).Scan(&count); err != nil || count != 0 {
			t.Fatal("product persisted without inventory")
		}
	})

	t.Run("inventory bounds reservations and concurrent adjustments", func(t *testing.T) {
		product := createProduct()
		path := "/api/v1/admin/products/" + product.ID + "/inventory"
		inventory := decodeResponse[commerce.Inventory](t, api.request(t, "PATCH", path, `{"delta":5}`, admin, nil, false, 200))
		if inventory.QuantityOnHand != 5 || inventory.QuantityAvailable != 5 || inventory.QuantityReserved != 0 {
			t.Fatal("inventory response mismatch")
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory SET quantity_reserved=3 WHERE product_id=$1`, product.ID); err != nil {
			t.Fatal(err)
		}
		api.request(t, "PATCH", path, `{"delta":-3}`, admin, nil, false, 409)
		inventory = decodeResponse[commerce.Inventory](t, api.request(t, "PATCH", path, `{"delta":-2}`, admin, nil, false, 200))
		if inventory.QuantityOnHand != 3 || inventory.QuantityReserved != 3 || inventory.QuantityAvailable != 0 {
			t.Fatal("adjustment did not preserve reservations")
		}
		api.request(t, "PATCH", path, `{"delta":2147483648}`, admin, nil, false, 422)
		api.request(t, "PATCH", path, `{"delta":-2147483648}`, admin, nil, false, 422)
		api.request(t, "PATCH", path, `{"delta":2147483647}`, admin, nil, false, 409)
		api.request(t, "PATCH", path, `{"delta":1.5}`, admin, nil, false, 400)
		concurrentRequests(t, api, 20, "PATCH", path, `{"delta":1}`, admin, 200)
		inventory = decodeResponse[commerce.Inventory](t, api.request(t, "PATCH", path, `{"delta":0}`, admin, nil, false, 200))
		if inventory.QuantityOnHand != 23 || inventory.QuantityReserved != 3 {
			t.Fatal("concurrent adjustments lost stock or changed reservations")
		}
		inventory = decodeResponse[commerce.Inventory](t, api.request(t, "PATCH", path, `{"delta":2147483624}`, admin, nil, false, 200))
		if int64(inventory.QuantityOnHand) != commerce.MaxStock || inventory.QuantityReserved != 3 {
			t.Fatal("maximum SQL INTEGER stock was not preserved")
		}
		api.request(t, "PATCH", path, `{"delta":1}`, admin, nil, false, 409)
		api.request(t, "PATCH", "/api/v1/admin/products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/inventory", `{"delta":1}`, admin, nil, false, 404)
	})

	t.Run("cart add replace removal isolation and versions", func(t *testing.T) {
		initial := getCart(token)
		if initial.Version != 1 || initial.Items == nil || len(initial.Items) != 0 {
			t.Fatal("new cart must be version one and []")
		}
		product := createProduct()
		cart := decodeResponse[commerce.Cart](t, add(product.ID, 2, token, 200))
		if cart.Version != 2 || len(cart.Items) != 1 || cart.Items[0].Quantity != 2 {
			t.Fatal("add cart mismatch")
		}
		item := cart.Items[0]
		cart = decodeResponse[commerce.Cart](t, add(product.ID, 3, token, 200))
		if cart.Version != 3 || len(cart.Items) != 1 || cart.Items[0].Quantity != 5 || cart.Items[0].ID != item.ID {
			t.Fatal("POST must add, retaining item identity")
		}
		path := "/api/v1/cart/items/" + item.ID
		cart = decodeResponse[commerce.Cart](t, api.request(t, "PATCH", path, `{"quantity":1}`, token, nil, false, 200))
		if cart.Version != 4 || cart.Items[0].Quantity != 1 {
			t.Fatal("PATCH must replace")
		}
		cart = decodeResponse[commerce.Cart](t, api.request(t, "PATCH", path, `{"quantity":1}`, token, nil, false, 200))
		if cart.Version != 5 {
			t.Fatal("same quantity must increment once")
		}
		otherBefore := getCart(other)
		api.request(t, "PATCH", path, `{"quantity":2}`, other, nil, false, 404)
		api.request(t, "DELETE", path, "", other, nil, false, 404)
		if after := getCart(other); after.Version != otherBefore.Version || len(after.Items) != 0 {
			t.Fatal("foreign item mutation changed cart")
		}
		api.request(t, "DELETE", path, "", token, nil, false, 204)
		api.request(t, "DELETE", path, "", token, nil, false, 404)
		cart = getCart(token)
		if cart.Version != 6 || len(cart.Items) != 0 {
			t.Fatal("missing removal changed cart")
		}
		clear()
		if getCart(token).Version != 7 {
			t.Fatal("empty clear must increment")
		}
		add(product.ID, 10000, token, 200)
		before := getCart(token)
		add(product.ID, 1, token, 422)
		if after := getCart(token); after.Version != before.Version || after.Items[0].Quantity != 10000 {
			t.Fatal("rejected total changed cart")
		}
		add(product.ID, 0, token, 422)
		add(product.ID, 10001, token, 422)
		add("bad", 1, token, 400)
		add("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, token, 404)
		api.request(t, "GET", "/api/v1/cart", "", "", nil, false, 401)
		api.request(t, "POST", "/api/v1/cart/items", `{"product_id":"`+product.ID+`","quantity":1.5}`, token, nil, false, 400)
		api.request(t, "POST", "/api/v1/cart/items", `{"product_id":"`+product.ID+`","quantity":1,"user_id":"`+adminUser.ID+`"}`, token, nil, false, 400)
		api.request(t, "DELETE", "/api/v1/admin/products/"+product.ID, "", admin, nil, false, 204)
		add(product.ID, 1, token, 404)
		api.request(t, "PATCH", "/api/v1/cart/items/"+before.Items[0].ID, `{"quantity":2}`, token, nil, false, 404)
		api.request(t, "DELETE", "/api/v1/cart/items/"+before.Items[0].ID, "", token, nil, false, 204)
		var onHand, reserved int
		if err := f.migrator.QueryRow(f.ctx, `SELECT quantity_on_hand,quantity_reserved FROM inventory WHERE product_id=$1`, product.ID).Scan(&onHand, &reserved); err != nil || onHand != 0 || reserved != 0 {
			t.Fatal("cart should not hold or require stock")
		}
	})

	t.Run("cart concurrent writers and coherent reads", func(t *testing.T) {
		clear()
		product := createProduct()
		before := getCart(token)
		responses := concurrentRequests(t, api, 30, "POST", "/api/v1/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, product.ID), token, 200)
		seen := map[int64]bool{}
		for _, response := range responses {
			cart := decodeResponse[commerce.Cart](t, response)
			if len(cart.Items) != 1 || int64(cart.Items[0].Quantity) != cart.Version-before.Version || seen[cart.Version] {
				t.Fatal("response mixed versions/items or duplicated increment")
			}
			seen[cart.Version] = true
		}
		after := getCart(token)
		if after.Version != before.Version+30 || len(after.Items) != 1 || after.Items[0].Quantity != 30 {
			t.Fatal("cart updates lost quantities/version increments")
		}
		// Hold the parent lock using an independent operator transaction. GET and
		// mutation must both wait instead of observing/writing unlocked items.
		tx, err := f.migrator.Begin(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(f.ctx) }()
		if _, err := tx.Exec(f.ctx, `SELECT id FROM carts WHERE user_id=$1 FOR UPDATE`, customer.ID); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		if _, err := commerce.NewService(f.pool).GetCart(ctx, customer.ID); err == nil {
			t.Fatal("cart read bypassed parent lock")
		}
		ctx2, cancel2 := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel2()
		if _, err := commerce.NewService(f.pool).AddCartItem(ctx2, customer.ID, product.ID, 1); err == nil {
			t.Fatal("cart writer bypassed parent lock")
		}
		if err := tx.Rollback(f.ctx); err != nil {
			t.Fatal(err)
		}
		if final := getCart(token); final.Version != after.Version || final.Items[0].Quantity != 30 {
			t.Fatal("cancelled writer changed cart")
		}
	})

	t.Run("cart rollback on version write failure", func(t *testing.T) {
		clear()
		product := createProduct()
		before := getCart(token)
		if _, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION fail_cart_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected version failure'; END $$; CREATE TRIGGER fail_cart BEFORE UPDATE ON carts FOR EACH ROW EXECUTE FUNCTION fail_cart_version();`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER fail_cart ON carts; DROP FUNCTION fail_cart_version();`); err != nil {
				t.Error(err)
			}
		})
		add(product.ID, 1, token, 500)
		after := getCart(token)
		if after.Version != before.Version || len(after.Items) != 0 {
			t.Fatal("failed version update left an item behind")
		}
	})

	t.Run("cart distinct capacity and version exhaustion", func(t *testing.T) {
		clear()
		product := createProduct()
		// Explicit operator fixtures fill 100 different product lines without
		// turning the test into 100 serialized HTTP setup calls.
		if _, err := f.migrator.Exec(f.ctx, `INSERT INTO products(id,sku,name,unit_price_cents) SELECT md5('capacity-'||n)::uuid,'CAP-'||n,'Capacity '||n,1 FROM generate_series(1,100) AS n;
INSERT INTO inventory(product_id) SELECT id FROM products WHERE sku LIKE 'CAP-%';`); err != nil {
			t.Fatal(err)
		}
		if _, err := f.migrator.Exec(f.ctx, `INSERT INTO cart_items(id,cart_id,product_id,quantity) SELECT p.id,c.id,p.id,1 FROM products p CROSS JOIN carts c WHERE p.sku LIKE 'CAP-%' AND c.user_id=$1`, customer.ID); err != nil {
			t.Fatal(err)
		}
		before := getCart(token)
		if len(before.Items) != 100 {
			t.Fatal("invalid capacity fixture")
		}
		add(product.ID, 1, token, 409)
		cart := decodeResponse[commerce.Cart](t, add(before.Items[0].ProductID, 1, token, 200))
		if len(cart.Items) != 100 || cart.Version != before.Version+1 {
			t.Fatal("existing product add should remain allowed at capacity")
		}
		clear()
		cart = decodeResponse[commerce.Cart](t, add(product.ID, 1, token, 200))
		if _, err := f.migrator.Exec(f.ctx, `UPDATE carts SET version=$2 WHERE user_id=$1`, customer.ID, commerce.MaxCartVersion-1); err != nil {
			t.Fatal(err)
		}
		cart = decodeResponse[commerce.Cart](t, add(product.ID, 1, token, 200))
		if cart.Version != commerce.MaxCartVersion {
			t.Fatal("final safe version rejected")
		}
		response := add(product.ID, 1, token, 409)
		if code := decodeResponse[struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}](t, response).Code; code != "cart_version_exhausted" {
			t.Fatal("wrong exhausted version code")
		}
		api.request(t, "PATCH", "/api/v1/cart/items/"+cart.Items[0].ID, `{"quantity":5}`, token, nil, false, 409)
		api.request(t, "DELETE", "/api/v1/cart/items/"+cart.Items[0].ID, "", token, nil, false, 409)
		api.request(t, "DELETE", "/api/v1/cart/items", "", token, nil, false, 409)
		if after := getCart(token); after.Version != cart.Version || len(after.Items) != 1 || after.Items[0].Quantity != 2 {
			t.Fatal("exhaustion did not roll back all mutations")
		}
	})

	t.Run("runtime privilege boundaries", func(t *testing.T) {
		for _, statement := range []string{`UPDATE users SET role='admin'`, `UPDATE users SET is_active=false`, `UPDATE addresses SET user_id=user_id`, `UPDATE inventory_reservations SET quantity=1`, `DELETE FROM products`, `UPDATE cart_items SET cart_id=cart_id`, `INSERT INTO goose_db_version(version_id,is_applied) VALUES(999,true)`} {
			_, err := f.pool.Exec(f.ctx, statement)
			pgError, ok := err.(*pgconn.PgError)
			if !ok || pgError.Code != "42501" {
				t.Fatalf("runtime privilege boundary failed: %s: %v", statement, err)
			}
		}
	})
}
