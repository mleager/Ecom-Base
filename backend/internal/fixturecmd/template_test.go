package fixturecmd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationDigestTracksMigrationFiles(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "backend", "migrations")
	if _, err := migrationDigest(root); err == nil {
		t.Fatal("missing migrations produced a template digest")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := migrationDigest(root); err == nil {
		t.Fatal("empty migrations produced a template digest")
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	digest := func() string {
		t.Helper()
		value, err := migrationDigest(root)
		if err != nil || len(value) != 64 {
			t.Fatal("migration digest failed")
		}
		return value
	}
	write("00001_a.sql", "-- +goose Up\nCREATE TABLE a();\n")
	first := digest()
	if digest() != first || !templatePattern.MatchString(templatePrefix+first[:16]) || namePattern.MatchString(templatePrefix+first[:16]) {
		t.Fatal("template name is unstable or reachable by check/remove")
	}
	write("00001_a.sql", "-- +goose Up\nCREATE TABLE b();\n")
	edited := digest()
	write("00002_b.sql", "-- +goose Up\n")
	added := digest()
	if err := os.Rename(filepath.Join(dir, "00002_b.sql"), filepath.Join(dir, "00003_b.sql")); err != nil {
		t.Fatal(err)
	}
	renamed := digest()
	seen := map[string]bool{first: true, edited: true, added: true, renamed: true}
	if len(seen) != 4 {
		t.Fatal("migration change did not select a new template")
	}
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := migrationDigest(root); err == nil {
		t.Fatal("non-file migration entry was accepted")
	}
}
