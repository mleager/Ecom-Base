//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/fixturecmd"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"
	"ecom/fixtures"

	"github.com/jackc/pgx/v5"
)

func TestFixtureWorkflow(t *testing.T) {
	f := newTestDatabase(t)
	seedCatalogProduct(t, f, "PRESERVE", "Existing data sentinel", true)
	var before string
	snapshot := `SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(p)) FROM products p),'inventory',(SELECT jsonb_agg(to_jsonb(i)) FROM inventory i))::text`
	if err := f.migrator.QueryRow(f.ctx, snapshot).Scan(&before); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	source, err := url.Parse(os.Getenv("ECOM_TEST_ADMIN_URL"))
	if err != nil {
		t.Fatal("integration administrator URL missing")
	}
	// Even the maintenance connection targets an owned sentinel database. A
	// fixture create may provision a new database, never seed this existing one.
	source.Path, source.RawPath = "/"+f.pool.Config().ConnConfig.Database, ""
	settings := map[string]string{
		"APP_ENV": "local", "ECOM_TEST_ADMIN_URL": source.String(),
		"ECOM_TEST_MIGRATOR_PASSWORD": os.Getenv("ECOM_TEST_MIGRATOR_PASSWORD"),
		"ECOM_TEST_APP_PASSWORD":      os.Getenv("ECOM_TEST_APP_PASSWORD"),
		"FRONTEND_ORIGIN":             authTestOrigin,
	}
	getenv := func(key string) string { return settings[key] }
	create := func() fixturecmd.Bundle {
		t.Helper()
		var output bytes.Buffer
		if err := fixturecmd.Run(f.ctx, root, []string{"create"}, getenv, &output); err != nil {
			t.Fatal(err)
		}
		var result struct {
			Fixture string `json:"fixture"`
		}
		if err := json.Unmarshal(output.Bytes(), &result); err != nil || !strings.HasPrefix(result.Fixture, "ecom_fixture_") {
			t.Fatal("fixture create omitted its identifier")
		}
		t.Cleanup(func() {
			cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
			defer stop()
			if err := fixturecmd.Run(cleanup, root, []string{"remove", result.Fixture}, getenv, io.Discard); err != nil {
				t.Error(err)
			}
		})
		var bundle fixturecmd.Bundle
		data, err := os.ReadFile(filepath.Join(root, ".cache/fixtures", result.Fixture, "bundle.json"))
		if err != nil || json.Unmarshal(data, &bundle) != nil {
			t.Fatal("private fixture bundle missing")
		}
		for _, account := range bundle.Accounts {
			if len(account.Password) != 64 || bytes.Contains(output.Bytes(), []byte(account.Password)) {
				t.Fatal("fixture credential not random-length/private")
			}
		}
		if bytes.Contains(output.Bytes(), []byte(bundle.DatabaseURL)) || bytes.Contains(output.Bytes(), []byte(bundle.JWTSecret)) || bytes.Contains(output.Bytes(), []byte(bundle.Token)) {
			t.Fatal("fixture create leaked a private configuration value")
		}
		return bundle
	}
	first, second := create(), create()
	if first.Name == second.Name || first.JWTSecret == second.JWTSecret || first.Accounts["admin"].Password == second.Accounts["admin"].Password || first.FixtureSHA256 != second.FixtureSHA256 {
		t.Fatal("repeated setup did not isolate secrets while retaining fixture identity")
	}
	pool, err := database.Open(f.ctx, first.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var pristine bool
	if err := pool.QueryRow(f.ctx, `SELECT
 (SELECT count(*) FROM orders)=0 AND (SELECT count(*) FROM payment_attempts)=0
 AND (SELECT count(*) FROM inventory_reservations)=0 AND (SELECT count(*) FROM user_sessions)=0
 AND (SELECT COALESCE(sum(quantity_reserved),0) FROM inventory)=0`).Scan(&pristine); err != nil || !pristine {
		t.Fatal("fresh fixtures contain sessions, purchases or leaked stock holds")
	}
	secret, err := base64.StdEncoding.DecodeString(first.JWTSecret)
	if err != nil {
		t.Fatal("fixture JWT configuration invalid")
	}
	authentication, err := auth.NewService(pool, secret, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	authHTTP := auth.NewHandler(authentication, auth.HTTPOptions{Origin: authTestOrigin})
	commerceHTTP := commerce.NewHandler(commerce.NewService(pool), authHTTP.Authenticate)
	server := httpserver.New("127.0.0.1:8080", func(ctx context.Context) error { return database.Ready(ctx, pool) }, slog.New(slog.NewTextHandler(io.Discard, nil)), authHTTP.RoutesWith(commerceHTTP.Routes))
	httpServer := httptest.NewServer(server.Handler)
	t.Cleanup(httpServer.Close)
	api := authAPI{httpServer}
	tokens := map[string]string{}
	passwords := map[string]bool{}
	for _, key := range []string{"customer_one", "customer_two", "admin"} {
		account := first.Accounts[key]
		if passwords[account.Password] {
			t.Fatal("fixture accounts share a password")
		}
		passwords[account.Password] = true
		token, _ := decodeTokens(t, api.request(t, "POST", "/api/v1/auth/login", credentialsBody(account.Email, account.Password), "", nil, true, 200))
		tokens[key] = token.AccessToken
		user := decodeResponse[auth.User](t, api.request(t, "GET", "/api/v1/users/me", "", token.AccessToken, nil, false, 200))
		if user.ID != account.ID || user.Role != account.Role {
			t.Fatal("fixture account role or identity mismatch")
		}
	}
	catalog, _, err := fixtures.Load()
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]fixtures.Product{}
	for _, p := range catalog.Products {
		byKey[p.Key] = p
	}
	active := decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/products?limit=100", "", "", nil, true, 200))
	all := decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/admin/products?limit=100", "", tokens["admin"], nil, false, 200))
	if len(active) != 34 || len(all) != 36 {
		t.Fatal("fixture active/retired counts mismatch")
	}
	for _, p := range all {
		if p.ImageURL != "" && !strings.HasPrefix(p.ImageURL, authTestOrigin+"/fixtures/v1/") {
			t.Fatal("fixture image uses a nonlocal/nonversioned source")
		}
	}
	firstPage := decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/products", "", "", nil, false, 200))
	for _, p := range firstPage {
		if p.ID == byKey["late_search"].ID {
			t.Fatal("late search fixture is not beyond page one")
		}
	}
	for _, tc := range []struct{ key, query string }{{"late_search", "needle-search"}, {"unicode", "CAFÉ"}, {"literal_search", `%_!\`}} {
		products := decodeResponse[[]commerce.Product](t, api.request(t, "GET", "/api/v1/products?q="+url.QueryEscape(tc.query), "", "", nil, false, 200))
		if len(products) != 1 || products[0].ID != byKey[tc.key].ID {
			t.Fatal("fixture search case is not reproducible")
		}
	}
	for _, key := range []string{"customer_one", "customer_two"} {
		addresses := decodeResponse[[]commerce.Address](t, api.request(t, "GET", "/api/v1/users/me/addresses", "", tokens[key], nil, false, 200))
		if len(addresses) != 1 || addresses[0].ID != first.Accounts[key].AddressIDs[0] {
			t.Fatal("owned address fixture mismatch")
		}
	}
	api.request(t, "DELETE", "/api/v1/users/me/addresses/"+first.Accounts["customer_two"].AddressIDs[0], "", tokens["customer_one"], nil, false, 404)
	api.request(t, "GET", "/api/v1/admin/products", "", tokens["customer_one"], nil, false, 403)
	cartOne := decodeResponse[commerce.Cart](t, api.request(t, "GET", "/api/v1/cart", "", tokens["customer_one"], nil, false, 200))
	cartTwo := decodeResponse[commerce.Cart](t, api.request(t, "GET", "/api/v1/cart", "", tokens["customer_two"], nil, false, 200))
	if len(cartOne.Items) != 0 || len(cartTwo.Items) != 3 || cartTwo.Version != 4 {
		t.Fatal("fixture cart baseline mismatch")
	}
	api.request(t, "GET", "/api/v1/products/"+byKey["retired"].ID, "", "", nil, false, 404)
	for _, item := range cartTwo.Items {
		if item.ProductID == byKey["retired"].ID {
			api.request(t, "DELETE", "/api/v1/cart/items/"+item.ID, "", tokens["customer_two"], nil, false, 204)
		}
	}
	if err := fixturecmd.Run(f.ctx, root, []string{"check", first.Name}, getenv, io.Discard); err != nil {
		t.Fatal("check rejected a legitimate mutated fixture")
	}
	admin, err := pgx.Connect(f.ctx, source.String())
	if err != nil {
		t.Fatal("fixture ownership test administrator unavailable")
	}
	defer admin.Close(context.Background())
	quoted := pgx.Identifier{first.Name}.Sanitize()
	if _, err := admin.Exec(f.ctx, "COMMENT ON DATABASE "+quoted+" IS 'foreign-marker'"); err != nil {
		t.Fatal(err)
	}
	refusal := fixturecmd.Run(f.ctx, root, []string{"remove", first.Name}, getenv, io.Discard)
	if _, err := admin.Exec(f.ctx, fmt.Sprintf("COMMENT ON DATABASE %s IS 'ecom-fixtures:v%d:%s'", quoted, first.Version, first.Token)); err != nil {
		t.Fatal("could not restore owned test marker")
	}
	if refusal == nil {
		t.Fatal("fixture removal ignored a mismatched database marker")
	}
	var stillExists bool
	if err := admin.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, first.Name).Scan(&stillExists); err != nil || !stillExists {
		t.Fatal("marker refusal changed the fixture database")
	}
	envPath := filepath.Join(root, ".cache/fixtures", first.Name, "api.env")
	environment, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal("fixture environment missing")
	}
	if err := os.WriteFile(envPath, []byte("APP_ENV=production\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tampered := fixturecmd.Run(f.ctx, root, []string{"check", first.Name}, getenv, io.Discard)
	if err := os.WriteFile(envPath, environment, 0o600); err != nil || tampered == nil {
		t.Fatal("fixture environment tampering was accepted")
	}
	badSettings := func(key string) string {
		if key == "ECOM_TEST_MIGRATOR_PASSWORD" {
			return "invalid-test-only-migrator-credential"
		}
		return getenv(key)
	}
	var failureOutput bytes.Buffer
	err = fixturecmd.Run(f.ctx, root, []string{"create"}, badSettings, &failureOutput)
	if err == nil || strings.Contains(err.Error(), "invalid-test-only") || failureOutput.Len() != 0 {
		t.Fatal("partial fixture create succeeded or leaked credentials")
	}
	failedName := regexp.MustCompile(`ecom_fixture_[a-f0-9]{16}`).FindString(err.Error())
	if failedName == "" || fixturecmd.Run(f.ctx, root, []string{"remove", failedName}, getenv, io.Discard) != nil {
		t.Fatal("partially created owned fixture could not be removed")
	}
	var after string
	if err := f.migrator.QueryRow(f.ctx, snapshot).Scan(&after); err != nil || before != after {
		t.Fatal("fixture setup/reset/removal changed existing database content")
	}
}
