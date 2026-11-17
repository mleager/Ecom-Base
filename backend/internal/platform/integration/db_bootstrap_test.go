//go:build integration

package integration

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"ecom/backend"
	"ecom/backend/internal/dbbootstrapcmd"
	"ecom/backend/internal/migratecmd"
	"ecom/backend/internal/platform/database"

	"github.com/jackc/pgx/v5"
)

// TestDBBootstrap runs the one-off role bootstrap (the ECS db-bootstrap task)
// against a new database that the administrator owns, three times at once
// and once more, then checks the result is what init.sh produces and that
// migrate and the runtime role work on it. The roles are cluster-wide and
// already exist here, so the test sets their existing test passwords.
func TestDBBootstrap(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	adminURL, err := url.Parse(os.Getenv("ECOM_TEST_ADMIN_URL"))
	if err != nil || adminURL == nil || adminURL.Host == "" {
		t.Fatal("set ECOM_TEST_ADMIN_URL explicitly; integration tests never silently skip")
	}
	migratorPassword, appPassword := os.Getenv("ECOM_TEST_MIGRATOR_PASSWORD"), os.Getenv("ECOM_TEST_APP_PASSWORD")
	if migratorPassword == "" || appPassword == "" {
		t.Fatal("set test app and migrator passwords for the bootstrapped PostgreSQL roles")
	}
	adminPassword, _ := adminURL.User.Password()

	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal("could not connect to test database administrator")
	}
	// Registered first, so it closes after the DROP DATABASE cleanup below.
	t.Cleanup(func() { _ = admin.Close(context.Background()) })

	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	name := "ecom_bootstrap_" + hex.EncodeToString(suffix[:])
	quoted := pgx.Identifier{name}.Sanitize()
	// Owned by the administrator, like the RDS database before bootstrap.
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
		t.Fatal("could not create disposable bootstrap database")
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, err := admin.Exec(cleanup, "DROP DATABASE "+quoted+" WITH (FORCE)"); err != nil {
			t.Errorf("could not remove disposable database %s", name)
		}
	})

	query := adminURL.Query()
	mode := query.Get("sslmode")
	if mode == "" {
		mode = "disable"
	}
	env := map[string]string{
		"APP_ENV":           "local",
		"DB_HOST":           adminURL.Hostname(),
		"DB_PORT":           adminURL.Port(),
		"DB_NAME":           name,
		"DB_USER":           adminURL.User.Username(),
		"DB_PASSWORD":       adminPassword,
		"DB_SSLMODE":        mode,
		"DB_SSLROOTCERT":    query.Get("sslrootcert"),
		"MIGRATOR_PASSWORD": migratorPassword,
		"APP_DB_PASSWORD":   appPassword,
	}
	run := func() (dbbootstrapcmd.Summary, error) {
		var stdout bytes.Buffer
		err := dbbootstrapcmd.Run(ctx, nil, func(key string) string { return env[key] }, &stdout, io.Discard)
		var summary dbbootstrapcmd.Summary
		if err == nil {
			if jsonErr := json.Unmarshal(stdout.Bytes(), &summary); jsonErr != nil {
				t.Errorf("bootstrap output is not one JSON line: %q", stdout.String())
			}
			for _, secret := range []string{adminPassword, migratorPassword, appPassword} {
				if bytes.Contains(stdout.Bytes(), []byte(secret)) {
					t.Error("bootstrap output contains a password")
				}
			}
		}
		return summary, err
	}

	// Concurrent runs queue on the advisory lock and all succeed.
	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = run()
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("concurrent bootstrap: %v", err)
		}
	}
	summary, err := run()
	if err != nil {
		t.Fatalf("repeated bootstrap: %v", err)
	}
	if summary.Event != "summary" || summary.Database != name || !summary.Ready || len(summary.Created) != 0 {
		t.Fatalf("summary %+v", summary)
	}

	target := *adminURL
	target.Path = "/" + name
	inspect, err := pgx.Connect(ctx, target.String())
	if err != nil {
		t.Fatal("could not connect to the bootstrapped database")
	}
	defer func() { _ = inspect.Close(context.Background()) }()

	for _, check := range []struct{ name, sql string }{
		{"database owner", `SELECT pg_get_userbyid(datdba) = 'ecom_migrator' FROM pg_database WHERE datname = current_database()`},
		{"no PUBLIC database privileges", `SELECT NOT EXISTS (SELECT FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database() AND a.grantee = 0)`},
		{"app CONNECT", `SELECT has_database_privilege('ecom_app', current_database(), 'CONNECT')`},
		{"app TEMPORARY denied", `SELECT NOT has_database_privilege('ecom_app', current_database(), 'TEMPORARY')`},
		{"schema owner", `SELECT pg_get_userbyid(nspowner) = 'ecom_migrator' FROM pg_namespace WHERE nspname = 'public'`},
		{"app schema USAGE", `SELECT has_schema_privilege('ecom_app', 'public', 'USAGE')`},
		{"app schema CREATE denied", `SELECT NOT has_schema_privilege('ecom_app', 'public', 'CREATE')`},
		{"default SELECT for app", `SELECT EXISTS (SELECT FROM pg_default_acl d, aclexplode(d.defaclacl) a
			WHERE pg_get_userbyid(d.defaclrole) = 'ecom_migrator' AND d.defaclnamespace = 'public'::regnamespace
			AND d.defaclobjtype = 'r' AND a.grantee = 'ecom_app'::regrole AND a.privilege_type = 'SELECT')`},
	} {
		var ok bool
		if err := inspect.QueryRow(ctx, check.sql).Scan(&ok); err != nil || !ok {
			t.Errorf("%s: ok=%v err=%v", check.name, ok, err)
		}
	}

	// The database is usable: migrate as the owner, then the runtime role is ready.
	roleURL := func(user, password string) string {
		u := target
		u.User = url.UserPassword(user, password)
		return u.String()
	}
	migrateEnv := map[string]string{"APP_ENV": "local", "DATABASE_URL": roleURL("ecom_migrator", migratorPassword)}
	if err := migratecmd.RunFS(ctx, backend.Migrations(), []string{"up"}, func(key string) string { return migrateEnv[key] }, io.Discard, io.Discard); err != nil {
		t.Fatalf("migrate on the bootstrapped database: %v", err)
	}
	pool, err := database.Open(ctx, roleURL("ecom_app", appPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := database.Ready(ctx, pool); err != nil {
		t.Fatalf("runtime role not ready after bootstrap and migrate: %v", err)
	}
}
