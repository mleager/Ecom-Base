package migratecmd

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"testing"

	"ecom/backend"
	"ecom/backend/internal/platform/database"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/pressly/goose/v3"
)

func TestParse(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		command string
		bad     bool
	}{
		{[]string{"up"}, "up", false},
		{[]string{"status"}, "status", false},
		{nil, "", true},
		{[]string{"down"}, "", true},
		{[]string{"down-to", "0"}, "", true},
		{[]string{"reset"}, "", true},
		{[]string{"up", "extra"}, "", true},
		{[]string{"--dir=private-secret"}, "", true},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			var help bytes.Buffer
			command, err := Parse(tc.args, &help)
			if (err != nil) != tc.bad || command != tc.command {
				t.Fatalf("command=%q err=%v", command, err)
			}
			if help.Len() > 0 || (err != nil && strings.Contains(err.Error(), "private-secret")) {
				t.Fatal("argument error leaked its input")
			}
		})
	}
	var help bytes.Buffer
	if _, err := Parse([]string{"--help"}, &help); !errors.Is(err, flag.ErrHelp) || !strings.Contains(help.String(), "status") {
		t.Fatal("help missing")
	}
	if err := Run(context.Background(), []string{"--help"}, func(string) string { t.Fatal("help read environment"); return "" }, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
}

// The binary must carry every migration, numbered without gaps, up to at
// least the version the API requires.
func TestEmbeddedMigrations(t *testing.T) {
	entries, err := fs.ReadDir(backend.Migrations(), ".")
	if err != nil {
		t.Fatal(err)
	}
	for i, entry := range entries {
		version, err := goose.NumericComponent(entry.Name())
		if err != nil || !strings.HasSuffix(entry.Name(), ".sql") || version != int64(i+1) {
			t.Fatalf("embedded file %s: version %d, error %v; want %d", entry.Name(), version, err, i+1)
		}
	}
	if latest := int64(len(entries)); latest < database.MinSchemaVersion {
		t.Fatalf("latest embedded migration %d is below the API minimum %d", latest, database.MinSchemaVersion)
	}
}

func TestConfigurationAndErrorsOmitSecrets(t *testing.T) {
	const secret = "private-secret"
	for _, tc := range []struct {
		name, environment, url string
	}{
		{"missing URL", "local", ""},
		{"unknown environment", "staging", "postgresql://ecom_migrator:" + secret + "@127.0.0.1:1/ecom?sslmode=disable"},
		{"plaintext production", "production", "postgresql://ecom_migrator:" + secret + "@db.example.test/ecom?sslmode=disable"},
		{"unreachable", "local", "postgresql://ecom_migrator:" + secret + "@127.0.0.1:1/ecom?sslmode=disable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, command := range []string{"up", "status"} {
				env := map[string]string{"APP_ENV": tc.environment, "DATABASE_URL": tc.url}
				var output, help bytes.Buffer
				err := Run(context.Background(), []string{command}, func(key string) string { return env[key] }, &output, &help)
				if err == nil {
					t.Fatalf("%s succeeded", command)
				}
				for _, text := range []string{err.Error(), output.String(), help.String()} {
					if strings.Contains(text, secret) || strings.Contains(text, "ecom_migrator") || strings.Contains(text, "127.0.0.1") {
						t.Fatalf("%s leaked connection settings: %q", command, text)
					}
				}
			}
		})
	}
}

func TestDescribe(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: "22012", Message: "division by zero"}), "SQLSTATE 22012: division by zero"},
		{fmt.Errorf("failed to initialize: %w", errors.New("failed to acquire lock")), "timed out waiting for the migration lock held by another run"},
		{fmt.Errorf("query: %w", context.DeadlineExceeded), "interrupted or deadline exceeded"},
	} {
		if got := describe(tc.err); got != tc.want {
			t.Errorf("describe(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}
