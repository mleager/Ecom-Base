package dbbootstrapcmd

import (
	"bytes"
	"context"
	"io"
	"net/url"
	"strings"
	"testing"
)

const (
	adminSecret    = "admin-private-secret-1"
	migratorSecret = "migrator-private-secret"
	appSecret      = "app-private-secret-xyz"
)

func environment(overrides map[string]string) func(string) string {
	env := map[string]string{
		"APP_ENV":           "production",
		"DB_HOST":           "db.example.internal",
		"DB_NAME":           "ecom",
		"DB_USER":           "ecom_admin",
		"DB_PASSWORD":       adminSecret,
		"DB_SSLROOTCERT":    "/etc/ssl/rds/global-bundle.pem",
		"MIGRATOR_PASSWORD": migratorSecret,
		"APP_DB_PASSWORD":   appSecret,
	}
	for k, v := range overrides {
		env[k] = v
	}
	return func(key string) string { return env[key] }
}

func TestLoad(t *testing.T) {
	s, err := Load(environment(nil))
	if err != nil {
		t.Fatal(err)
	}
	if s.Database != "ecom" || s.AdminUser != "ecom_admin" {
		t.Fatalf("settings %+v", s)
	}
	for _, want := range []string{"db.example.internal:5432/ecom", "sslmode=verify-full", "sslrootcert=%2Fetc%2Fssl%2Frds%2Fglobal-bundle.pem"} {
		if !strings.Contains(s.ConnectionURL, want) {
			t.Fatalf("connection URL missing %q", want)
		}
	}

	// A managed master password can contain URL-special characters.
	const special = "p@ss/w:rd?#&=x% y"
	s, err = Load(environment(map[string]string{"DB_PASSWORD": special}))
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(s.ConnectionURL)
	if err != nil {
		t.Fatal(err)
	}
	if password, _ := u.User.Password(); password != special || u.Hostname() != "db.example.internal" {
		t.Fatal("special-character password did not round-trip")
	}
}

func TestLoadRejectsAndOmitsSecrets(t *testing.T) {
	for _, tc := range []struct {
		name      string
		overrides map[string]string
	}{
		{"missing host", map[string]string{"DB_HOST": ""}},
		{"missing admin password", map[string]string{"DB_PASSWORD": ""}},
		{"unknown environment", map[string]string{"APP_ENV": "staging"}},
		{"plain text in production", map[string]string{"DB_SSLMODE": "disable"}},
		{"plain text to a remote host locally", map[string]string{"APP_ENV": "local", "DB_SSLMODE": "disable"}},
		{"short migrator password", map[string]string{"MIGRATOR_PASSWORD": "short"}},
		{"short app password", map[string]string{"APP_DB_PASSWORD": "short"}},
		{"shared role password", map[string]string{"APP_DB_PASSWORD": migratorSecret}},
		{"role password equals admin", map[string]string{"MIGRATOR_PASSWORD": adminSecret}},
		{"non-ASCII migrator password", map[string]string{"MIGRATOR_PASSWORD": "migrator-pässword-1234"}},
		{"control character in app password", map[string]string{"APP_DB_PASSWORD": "app-password-1234\n"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(environment(tc.overrides))
			if err == nil {
				t.Fatal("accepted")
			}
			for _, secret := range []string{adminSecret, migratorSecret, appSecret, "db.example.internal"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("error leaked %q: %v", secret, err)
				}
			}
		})
	}

	if _, err := Load(environment(map[string]string{"APP_ENV": "local", "DB_HOST": "127.0.0.1", "DB_SSLMODE": "disable"})); err != nil {
		t.Fatalf("local loopback without TLS: %v", err)
	}
}

func TestRunArgumentsAndHelp(t *testing.T) {
	var help bytes.Buffer
	if err := Run(context.Background(), []string{"--help"}, func(string) string { t.Fatal("help read environment"); return "" }, io.Discard, &help); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(help.String(), "MIGRATOR_PASSWORD") {
		t.Fatal("help missing settings")
	}
	if err := Run(context.Background(), []string{"--force"}, environment(nil), io.Discard, io.Discard); err == nil {
		t.Fatal("accepted an argument")
	}
}

// A connection failure names neither the host, user nor any password.
func TestConnectionErrorOmitsSecrets(t *testing.T) {
	env := environment(map[string]string{"APP_ENV": "local", "DB_HOST": "127.0.0.1", "DB_PORT": "1", "DB_SSLMODE": "disable"})
	err := Run(context.Background(), nil, env, io.Discard, io.Discard)
	if err == nil {
		t.Fatal("connected to port 1")
	}
	for _, secret := range []string{adminSecret, migratorSecret, appSecret, "ecom_admin", "127.0.0.1"} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("error leaked %q: %v", secret, err)
		}
	}
}
