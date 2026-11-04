//go:build integration

package integration

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"
)

type catalogAPI struct {
	authAPI
	customer, admin, adminID string
}

func newCatalogAPI(t *testing.T, f *testDatabase) catalogAPI {
	t.Helper()
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
	register := func(email string) (string, string) {
		t.Helper()
		user := decodeResponse[auth.User](t, api.request(t, "POST", "/api/v1/auth/register", registrationBody(email), "", nil, false, 201))
		tokens, _ := decodeTokens(t, api.request(t, "POST", "/api/v1/auth/login", credentialsBody(email, authTestPassword), "", nil, true, 200))
		return user.ID, tokens.AccessToken
	}
	_, customer := register("catalog-customer@example.com")
	adminID, admin := register("catalog-admin@example.com")
	if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET role='admin' WHERE id=$1`, adminID); err != nil {
		t.Fatal(err)
	}
	return catalogAPI{authAPI: api, customer: customer, admin: admin, adminID: adminID}
}

func seedCatalogProduct(t *testing.T, f *testDatabase, sku, name string, active bool) string {
	t.Helper()
	id := checkoutID(t)
	if _, err := f.migrator.Exec(f.ctx, `INSERT INTO products(id,sku,name,unit_price_cents,is_active) VALUES($1,$2,$3,1234,$4)`, id, sku, name, active); err != nil {
		t.Fatal(err)
	}
	if _, err := f.migrator.Exec(f.ctx, `INSERT INTO inventory(product_id,quantity_on_hand,quantity_reserved) VALUES($1,10,2)`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestProductSearch(t *testing.T) {
	f := newTestDatabase(t)
	api := newCatalogAPI(t, f)
	for i := range 22 {
		seedCatalogProduct(t, f, fmt.Sprintf("BROWSE-%02d", i), fmt.Sprintf("A product %02d", i), true)
	}
	late := seedCatalogProduct(t, f, "TARGET-Needle", "Zulu target", true)
	cafe := seedCatalogProduct(t, f, "CAFE", "Café Lamp", true)
	literal := seedCatalogProduct(t, f, "LITERAL", `Literal%_!\ token`, true)
	seedCatalogProduct(t, f, "DECOY", "LiteralXYZ token", true)
	retired := seedCatalogProduct(t, f, "RETIRED-Needle", "Zulu retired", false)
	pageIDs := []string{}
	for i := range 3 {
		pageIDs = append(pageIDs, seedCatalogProduct(t, f, fmt.Sprintf("PAGE-%d", i), "Same needle", true))
	}
	sort.Strings(pageIDs)
	list := func(query string) []commerce.Product {
		t.Helper()
		return decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/products?"+query, "", "", nil, false, 200))
	}
	t.Run("filter before pagination and active only", func(t *testing.T) {
		first := list("")
		if len(first) != 20 {
			t.Fatal("browse page size changed")
		}
		for _, p := range first {
			if p.ID == late || p.ID == retired {
				t.Fatal("unexpected product on first browse page")
			}
		}
		for _, query := range []string{"q=", "q=%20%09%E2%80%83"} {
			products := list(query)
			if len(products) != len(first) {
				t.Fatal("empty query did not browse")
			}
			for i := range first {
				if first[i].ID != products[i].ID {
					t.Fatal("empty query changed browse ordering")
				}
			}
		}
		for _, tc := range []struct{ term, id string }{
			{"target-needle", late}, {" ZULU TARGET ", late}, {"CAFÉ", cafe},
			{`literal%_!\`, literal}, {"%", literal}, {"_", literal}, {"!", literal}, {`\`, literal},
		} {
			products := list("q=" + url.QueryEscape(tc.term))
			if len(products) != 1 || products[0].ID != tc.id || products[0].AvailableQuantity != 8 {
				t.Fatalf("literal/name/SKU search %q returned unexpected products", tc.term)
			}
		}
		for _, term := range []string{"no matches", "' OR true --", "RETIRED-Needle", strings.Repeat("é", 200)} {
			if products := list("q=" + url.QueryEscape(term)); products == nil || len(products) != 0 {
				t.Fatal("no-match/retired search should return []")
			}
		}
		for i, id := range pageIDs {
			products := list(fmt.Sprintf("q=same+needle&limit=1&offset=%d", i))
			if len(products) != 1 || products[0].ID != id {
				t.Fatal("filtered ties are not ordered by UUID")
			}
		}
		if products := list("q=same+needle&offset=9223372036854775807"); products == nil || len(products) != 0 {
			t.Fatal("large result-set offset should return []")
		}
	})
	t.Run("strict wire grammar and origin policy", func(t *testing.T) {
		for _, tc := range []struct {
			query  string
			status int
		}{
			{"q=a&q=b", 400}, {"q=%zz", 400}, {"q=%ff", 422}, {"q=%00", 422},
			{"q=" + url.QueryEscape(strings.Repeat("é", 201)), 422},
			{"q=target&limit=0", 422}, {"q=target&offset=-1", 422}, {"q=target&offset=9223372036854775808", 422},
			{"q=target&limit=1.5", 400}, {"q=target&offset=", 400}, {"is_active=false", 400}, {"sort=name", 400},
		} {
			api.request(t, "GET", "/api/v1/products?"+tc.query, "", "", nil, false, tc.status)
		}
		response := api.request(t, "GET", "/api/v1/products?q=target", "", "", nil, true, 200)
		if response.headers.Get("Access-Control-Allow-Origin") != authTestOrigin || response.headers.Get("Access-Control-Allow-Credentials") != "true" {
			t.Fatal("search bypassed the credentialed origin policy")
		}
	})
}

func TestAdminCatalogReads(t *testing.T) {
	f := newTestDatabase(t)
	api := newCatalogAPI(t, f)
	active := seedCatalogProduct(t, f, "ACTIVE", "Same name", true)
	retired := seedCatalogProduct(t, f, "RETIRED", "Same name", false)
	root := "/api/v1/admin/products"
	paths := []string{root, root + "/" + retired, root + "/" + retired + "/inventory"}
	read := func(path string, status int) authResponse {
		t.Helper()
		return api.request(t, "GET", path, "", api.admin, nil, true, status)
	}
	t.Run("guarded reload reads and filters", func(t *testing.T) {
		for _, path := range paths {
			api.request(t, "GET", path, "", "", nil, false, 401)
			api.request(t, "GET", path, "", api.customer, nil, false, 403)
		}
		all := decodeResponse[[]commerce.Product](t, read(root, 200))
		ids := []string{active, retired}
		sort.Strings(ids)
		if len(all) != 2 || all[0].ID != ids[0] || all[1].ID != ids[1] {
			t.Fatal("admin list did not include both states in name/ID order")
		}
		for _, tc := range []struct{ filter, id string }{{"true", active}, {"false", retired}} {
			products := decodeResponse[[]commerce.Product](t, read(root+"?is_active="+tc.filter, 200))
			if len(products) != 1 || products[0].ID != tc.id {
				t.Fatal("admin activity filter mismatch")
			}
		}
		page := decodeResponse[[]commerce.Product](t, read(root+"?limit=1&offset=1", 200))
		if len(page) != 1 || page[0].ID != ids[1] {
			t.Fatal("admin pagination mismatch")
		}
		if page := decodeResponse[[]commerce.Product](t, read(root+"?offset=99", 200)); page == nil || len(page) != 0 {
			t.Fatal("empty admin page should return []")
		}
		for _, id := range []string{active, retired} {
			response := read(root+"/"+id, 200)
			product := decodeResponse[commerce.Product](t, response)
			if product.ID != id || product.IsActive != (id == active) || product.AvailableQuantity != 8 || product.UnitPriceCents != 1234 {
				t.Fatal("admin detail shape/retired visibility mismatch")
			}
			if response.headers.Get("Access-Control-Allow-Origin") != authTestOrigin {
				t.Fatal("admin detail omitted origin policy")
			}
			inventory := decodeResponse[commerce.Inventory](t, read(root+"/"+id+"/inventory", 200))
			if inventory.ProductID != id || inventory.QuantityOnHand != 10 || inventory.QuantityReserved != 2 || inventory.QuantityAvailable != 8 {
				t.Fatal("admin inventory shape mismatch")
			}
		}
		api.request(t, "GET", "/api/v1/products/"+retired, "", "", nil, false, 404)
		public := decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/products", "", "", nil, false, 200))
		if len(public) != 1 || public[0].ID != active {
			t.Fatal("admin reads exposed retired products publicly")
		}
		api.request(t, "PATCH", root+"/"+retired, `{"is_active":true}`, api.admin, nil, false, 200)
		api.request(t, "GET", "/api/v1/products/"+retired, "", "", nil, false, 200)
		api.request(t, "DELETE", root+"/"+retired, "", api.admin, nil, false, 204)
	})
	t.Run("grammar and absent resources", func(t *testing.T) {
		for _, tc := range []struct {
			query  string
			status int
		}{
			{"is_active=", 400}, {"is_active=TRUE", 400}, {"is_active=1", 400}, {"is_active=true&is_active=false", 400},
			{"q=a&q=b", 400}, {"limit=1&limit=2", 400}, {"limit=%zz", 400}, {"offset=1.5", 400},
			{"limit=101", 422}, {"offset=-1", 422}, {"offset=9223372036854775808", 422},
		} {
			read(root+"?"+tc.query, tc.status)
		}
		for _, suffix := range []string{"", "/inventory"} {
			read(root+"/bad-id"+suffix, 400)
			read(root+"/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"+suffix, 404)
		}
	})
	t.Run("reads preserve timestamps and corruption is not hidden", func(t *testing.T) {
		snapshot := func() string {
			t.Helper()
			var value string
			if err := f.migrator.QueryRow(f.ctx, `SELECT jsonb_build_object('product',to_jsonb(p),'inventory',to_jsonb(i))::text FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id=$1`, retired).Scan(&value); err != nil {
				t.Fatal(err)
			}
			return value
		}
		before := snapshot()
		for _, path := range paths {
			read(path, 200)
		}
		if snapshot() != before {
			t.Fatal("GET changed product/inventory data or timestamps")
		}
		if _, err := f.migrator.Exec(f.ctx, `DELETE FROM inventory WHERE product_id=$1`, retired); err != nil {
			t.Fatal(err)
		}
		before = snapshot()
		for _, path := range paths {
			response := read(path, 500)
			if strings.Contains(string(response.body), "inventory missing") || strings.Contains(string(response.body), retired) {
				t.Fatal("corrupt graph leaked internal error details")
			}
		}
		if snapshot() != before {
			t.Fatal("corrupt graph was silently repaired")
		}
	})
	t.Run("one statement observes coherent concurrent counters", func(t *testing.T) {
		if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory SET quantity_on_hand=10,quantity_reserved=0 WHERE product_id=$1`, active); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			for i := range 100 {
				if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory SET quantity_on_hand=$2,quantity_reserved=$3 WHERE product_id=$1`, active, i+10, i); err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}()
		for range 100 {
			inventory := decodeResponse[commerce.Inventory](t, read(root+"/"+active+"/inventory", 200))
			if inventory.QuantityAvailable != 10 || inventory.QuantityOnHand-inventory.QuantityReserved != 10 {
				t.Error("inventory response mixed counter snapshots")
			}
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		api.request(t, "PATCH", root+"/"+active+"/inventory", `{"delta":1}`, api.admin, nil, false, 200)
		inventory := decodeResponse[commerce.Inventory](t, read(root+"/"+active+"/inventory", 200))
		if inventory.QuantityOnHand != 110 || inventory.QuantityReserved != 99 || inventory.QuantityAvailable != 11 {
			t.Fatal("signed stock adjustment did not survive GET reload")
		}
	})
	t.Run("current database role and activation own every read", func(t *testing.T) {
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET role='customer' WHERE id=$1`, api.adminID); err != nil {
			t.Fatal(err)
		}
		for _, path := range paths {
			read(path, 403)
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET role='admin',is_active=false WHERE id=$1`, api.adminID); err != nil {
			t.Fatal(err)
		}
		for _, path := range paths {
			read(path, 401)
		}
	})
}

func TestCartPresentationReadiness(t *testing.T) {
	f := newTestDatabase(t)
	api := newCatalogAPI(t, f)
	active := seedCatalogProduct(t, f, "PRICED", "Priced line", true)
	unavailable := seedCatalogProduct(t, f, "UNAVAILABLE", "Retired line", true)
	if _, err := f.migrator.Exec(f.ctx, `UPDATE products SET unit_price_cents=$2 WHERE id=$1`, active, commerce.MaxPrice); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{active, unavailable} {
		api.request(t, "POST", "/api/v1/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":10000}`, id), api.customer, nil, false, 200)
	}
	api.request(t, "DELETE", "/api/v1/admin/products/"+unavailable, "", api.admin, nil, false, 204)
	cart := decodeResponse[commerce.Cart](t, api.request(t, "GET", "/api/v1/cart", "", api.customer, nil, false, 200))
	if len(cart.Items) != 2 {
		t.Fatal("retirement removed a persistent cart line")
	}
	product := decodeResponse[commerce.Product](t, api.request(t, "GET", "/api/v1/products/"+active, "", "", nil, false, 200))
	if product.UnitPriceCents != commerce.MaxPrice || product.ImageURL != "" {
		t.Fatal("public enrichment did not retain bounded price or missing-image fallback input")
	}
	api.request(t, "GET", "/api/v1/products/"+unavailable, "", "", nil, false, 404)
	for _, item := range cart.Items {
		if int64(item.Quantity) != commerce.MaxQuantity {
			t.Fatal("large valid cart quantity was changed")
		}
		if item.ProductID == unavailable {
			api.request(t, "DELETE", "/api/v1/cart/items/"+item.ID, "", api.customer, nil, false, 204)
		}
	}
	cart = decodeResponse[commerce.Cart](t, api.request(t, "GET", "/api/v1/cart", "", api.customer, nil, false, 200))
	if len(cart.Items) != 1 || cart.Items[0].ProductID != active {
		t.Fatal("unavailable line could not be removed independently of enrichment")
	}
}
