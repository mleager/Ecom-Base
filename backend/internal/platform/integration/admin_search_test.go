//go:build integration

package integration

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
	"testing"

	"ecom/backend/internal/commerce"
)

func TestAdminProductSearch(t *testing.T) {
	f := newTestDatabase(t)
	api := newCatalogAPI(t, f)
	for i := range 22 {
		seedCatalogProduct(t, f, fmt.Sprintf("BROWSE-%d", i), fmt.Sprintf("A product %02d", i), true)
	}
	late := seedCatalogProduct(t, f, "NEEDLE-SKU", "Zulu product", true)
	retired := seedCatalogProduct(t, f, "RETIRED-NEEDLE", "Zulu retired", false)
	literal := seedCatalogProduct(t, f, "LITERAL", `Literal%_!\ token`, true)
	seedCatalogProduct(t, f, "DECOY", "LiteralXYZ token", true)
	cafe := seedCatalogProduct(t, f, "CAFE", "Café Lamp", true)
	maximum := seedCatalogProduct(t, f, "MAXIMUM", strings.Repeat("é", 200), true)
	ids := []string{seedCatalogProduct(t, f, "TIE-1", "Same needle", true), seedCatalogProduct(t, f, "TIE-2", "Same needle", true)}
	sort.Strings(ids)
	list := func(query string) []commerce.Product {
		t.Helper()
		return decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/admin/products?"+query, "", api.admin, nil, false, 200))
	}
	for _, tc := range []struct{ q, filter, id string }{
		{"needle-sku", "true", late}, {"RETIRED-needle", "false", retired}, {`%_!\`, "true", literal}, {"fé", "true", cafe}, {strings.Repeat("é", 200), "true", maximum},
	} {
		products := list("q=" + url.QueryEscape(tc.q) + "&is_active=" + tc.filter)
		if len(products) != 1 || products[0].ID != tc.id {
			t.Fatalf("literal/admin filter failed for %q", tc.q)
		}
	}
	for i, id := range ids {
		rows := list(fmt.Sprintf("q=same+needle&limit=1&offset=%d", i))
		if len(rows) != 1 || rows[0].ID != id {
			t.Fatal("search ordering/pagination")
		}
	}
	if rows := list("q=same+needle&offset=100"); rows == nil || len(rows) != 0 {
		t.Fatal("empty far page")
	}
	if rows := list("q=NEEDLE&is_active=false"); len(rows) != 1 || rows[0].ID != retired {
		t.Fatal("activation predicate broadened")
	}
	for _, q := range []string{"' OR true --", "no-such-product"} {
		if rows := list("q=" + url.QueryEscape(q)); len(rows) != 0 {
			t.Fatal("search not literal")
		}
	}
	for _, tc := range []struct {
		q      string
		status int
	}{
		{"q=a&q=b", 400}, {"q=%zz", 400}, {"q=%ff", 422}, {"q=%00", 422}, {"q=" + url.QueryEscape(strings.Repeat("é", 201)), 422},
	} {
		api.request(t, "GET", "/api/v1/admin/products?"+tc.q, "", api.admin, nil, false, tc.status)
	}
	api.request(t, "GET", "/api/v1/admin/products?q=needle", "", "", nil, false, 401)
	api.request(t, "GET", "/api/v1/admin/products?q=needle", "", api.customer, nil, false, 403)
	public := decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/products?q=RETIRED-NEEDLE", "", "", nil, false, 200))
	if len(public) != 0 {
		t.Fatal("inactive search leaked to public")
	}
}
