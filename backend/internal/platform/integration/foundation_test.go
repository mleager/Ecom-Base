//go:build integration

package integration

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tests create and own one randomly named database. They never migrate or reset
// the development database supplied in ECOM_TEST_ADMIN_URL.
func TestFoundation(t *testing.T) {
	f := newTestDatabase(t)
	ctx, migrator, pool, migrate := f.ctx, f.migrator, f.pool, f.migrate

	t.Run("schema and restricted runtime", func(t *testing.T) {
		var count int
		if err := migrator.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`).Scan(&count); err != nil || count != 22 {
			t.Fatalf("table count = %d, error = %v; expected 21 domain tables plus goose", count, err)
		}
		var canChangeSchema, canChangeVersion bool
		if err := pool.QueryRow(ctx, `SELECT has_schema_privilege(current_user,'public','CREATE'), has_table_privilege(current_user,'public.goose_db_version','UPDATE')`).Scan(&canChangeSchema, &canChangeVersion); err != nil {
			t.Fatal(err)
		}
		if canChangeSchema || canChangeVersion {
			t.Fatal("runtime credentials can modify schema or migration metadata")
		}
		var version string
		if err := pool.QueryRow(ctx, "SHOW server_version").Scan(&version); err != nil {
			t.Fatal(err)
		}
		t.Logf("real PostgreSQL server %s; schema version %d", version, database.SchemaVersion)
	})

	const user = "11111111-1111-4111-8111-111111111111"
	const product = "22222222-2222-4222-8222-222222222222"
	const retired = "33333333-3333-4333-8333-333333333333"
	const cart = "44444444-4444-4444-8444-444444444444"
	const order = "55555555-5555-4555-8555-555555555555"
	_, err := migrator.Exec(ctx, `
INSERT INTO users(id,first_name,last_name,email,password_hash) VALUES('`+user+`','Test','Customer','test@example.com','fixture-verifier');
INSERT INTO products(id,sku,name,unit_price_cents) VALUES('`+product+`','ACTIVE','Active product',1234);
INSERT INTO products(id,sku,name,unit_price_cents,is_active) VALUES('`+retired+`','RETIRED','Retired product',999,false);
INSERT INTO inventory(product_id,quantity_on_hand,quantity_reserved) VALUES('`+product+`',7,2),('`+retired+`',3,0);
INSERT INTO carts(id,user_id) VALUES('`+cart+`','`+user+`');
INSERT INTO orders(id,user_id,status,subtotal_cents,total_cents,shipping_address,source_cart_id,source_cart_version,reservation_expires_at)
VALUES('`+order+`','`+user+`','pending_payment',1234,1234,'{}','`+cart+`',1,now()+interval '15 minutes');`)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("generated catalog queries", func(t *testing.T) {
		queries := db.New(pool)
		products, err := queries.ListProducts(ctx, db.ListProductsParams{PageLimit: 20})
		if err != nil || len(products) != 1 || products[0].AvailableQuantity != 5 || products[0].UnitPriceCents != 1234 {
			t.Fatalf("unexpected active product query result: %v", err)
		}
		var retiredID pgtype.UUID
		if err := retiredID.Scan(retired); err != nil {
			t.Fatal(err)
		}
		if _, err := queries.GetProduct(ctx, retiredID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("retired product lookup returned %v", err)
		}
		products, err = queries.ListProducts(ctx, db.ListProductsParams{PageLimit: 20, PageOffset: 1})
		if err != nil || products == nil || len(products) != 0 {
			t.Fatal("empty page should be a nonnil empty slice")
		}
	})

	for _, tc := range []struct{ name, statement, code string }{
		{"canonical email", `UPDATE users SET email=' Test@Example.com '`, "23514"},
		{"unique email", `INSERT INTO users(id,first_name,last_name,email,password_hash) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Test','Other','test@example.com','fixture')`, "23505"},
		{"credential version nonnegative", `UPDATE users SET credential_version=-1`, "23514"},
		{"inventory nonnegative", `UPDATE inventory SET quantity_on_hand=-1`, "23514"},
		{"reserved within stock", `UPDATE inventory SET quantity_reserved=quantity_on_hand+1`, "23514"},
		{"reserved nonnegative", `UPDATE inventory SET quantity_reserved=-1`, "23514"},
		{"price nonnegative", `UPDATE products SET unit_price_cents=-1`, "23514"},
		{"cart version positive", `UPDATE carts SET version=0`, "23514"},
		{"cart item positive", `INSERT INTO cart_items(id,cart_id,product_id,quantity) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','` + cart + `','` + product + `',0)`, "23514"},
		{"order status", `UPDATE orders SET status='payment_unknown'`, "23514"},
		{"order totals", `UPDATE orders SET total_cents=0`, "23514"},
		{"order snapshot object", `UPDATE orders SET shipping_address='[]'`, "23514"},
		{"history retention", `DELETE FROM products WHERE id='` + product + `'`, "23503"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx, err := migrator.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			_, err = tx.Exec(ctx, tc.statement)
			var pgError *pgconn.PgError
			if !errors.As(err, &pgError) || pgError.Code != tc.code {
				t.Fatalf("expected SQLSTATE %s, got %v", tc.code, err)
			}
		})
	}

	t.Run("HTTP readiness follows actual schema", func(t *testing.T) {
		server := httpserver.New("127.0.0.1:8080", func(ctx context.Context) error { return database.Ready(ctx, pool) }, slog.New(slog.NewTextHandler(io.Discard, nil)))
		assertReady := func(want int) {
			t.Helper()
			response := httptest.NewRecorder()
			server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
			if response.Code != want {
				t.Fatalf("readiness = %d, want %d", response.Code, want)
			}
		}
		assertReady(http.StatusOK)
		migrate("down-to", "0")
		assertReady(http.StatusServiceUnavailable)
		migrate("up")
		assertReady(http.StatusOK)
	})
}

func filteredEnvironment() []string {
	var result []string
	for _, entry := range os.Environ() {
		upper := strings.ToUpper(entry)
		if !strings.HasPrefix(upper, "GOOSE_") {
			result = append(result, entry)
		}
	}
	return result
}

type testDatabase struct {
	ctx      context.Context
	migrator *pgx.Conn
	pool     *pgxpool.Pool
	migrate  func(...string)
}

func newTestDatabase(t *testing.T) *testDatabase {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	adminURL, err := url.Parse(os.Getenv("ECOM_TEST_ADMIN_URL"))
	if err != nil || adminURL == nil || adminURL.Host == "" {
		t.Fatal("set ECOM_TEST_ADMIN_URL explicitly; integration tests never silently skip")
	}
	appPassword := os.Getenv("ECOM_TEST_APP_PASSWORD")
	migratorPassword := os.Getenv("ECOM_TEST_MIGRATOR_PASSWORD")
	if appPassword == "" || migratorPassword == "" {
		t.Fatal("set test app and migrator passwords for the bootstrapped PostgreSQL roles")
	}
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal("could not connect to test database administrator")
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	databaseName := "ecom_foundation_" + hex.EncodeToString(suffix[:])
	quotedName := pgx.Identifier{databaseName}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quotedName+" OWNER ecom_migrator"); err != nil {
		t.Fatal("could not create disposable foundation database")
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, err := admin.Exec(cleanup, "DROP DATABASE "+quotedName+" WITH (FORCE)"); err != nil {
			t.Errorf("could not remove owned disposable database %s", databaseName)
		}
	})
	connection := func(user, password string) string {
		copyURL := *adminURL
		copyURL.User = url.UserPassword(user, password)
		copyURL.Path = "/" + databaseName
		return copyURL.String()
	}
	migratorURL := connection("ecom_migrator", migratorPassword)
	migrator, err := pgx.Connect(ctx, migratorURL)
	if err != nil {
		t.Fatal("could not connect as migrator")
	}
	t.Cleanup(func() { _ = migrator.Close(context.Background()) })
	if _, err := migrator.Exec(ctx, `GRANT USAGE ON SCHEMA public TO ecom_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ecom_app;`); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, connection("ecom_app", appPassword))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := database.Ready(ctx, pool); err == nil {
		t.Fatal("unmigrated database incorrectly reported ready")
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate migrations")
	}
	migrations := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../migrations"))
	migrate := func(args ...string) {
		t.Helper()
		command := exec.CommandContext(ctx, "goose", append([]string{"-env=none", "-dir", migrations}, args...)...)
		// Existing process values must not redirect goose to another database/table.
		command.Env = append(filteredEnvironment(), "GOOSE_DRIVER=postgres", "GOOSE_DBSTRING="+migratorURL, "GOOSE_TABLE=public.goose_db_version")
		if err := command.Run(); err != nil {
			t.Fatalf("local goose %s failed: %v", strings.Join(args, " "), err)
		}
	}
	migrate("up")
	migrate("up")
	if err := database.Ready(ctx, pool); err != nil {
		t.Fatal("migrated runtime connection is not ready")
	}

	return &testDatabase{ctx, migrator, pool, migrate}
}
