package fixturecmd

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFixtureArgumentsAndFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module ecom\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{nil, {"create", "secret"}, {"remove", "ecom"}, {"check", "../private-secret"}, {"unknown-secret"}} {
		var out bytes.Buffer
		err := Run(context.Background(), root, args, func(string) string { return "" }, &out)
		if err == nil || strings.Contains(err.Error(), "secret") || out.Len() != 0 {
			t.Fatal("invalid fixture arguments were accepted or echoed")
		}
	}
	var help bytes.Buffer
	if err := Run(context.Background(), root, []string{"--help"}, func(string) string { t.Fatal("help read environment"); return "" }, &help); err != nil || help.Len() == 0 {
		t.Fatal("fixture help failed")
	}
	for _, settings := range []map[string]string{
		{"APP_ENV": "production"},
		{"APP_ENV": "local", "ECOM_TEST_ADMIN_URL": "postgresql://postgres:secret@remote.example/ecom?sslmode=verify-full"},
		{"APP_ENV": "local", "ECOM_TEST_ADMIN_URL": "postgresql://postgres:secret@localhost/ecom?sslmode=disable&host=remote.example"},
	} {
		err := Run(context.Background(), root, []string{"create"}, func(k string) string { return settings[k] }, &bytes.Buffer{})
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("fixture runtime policy failed or leaked credentials")
		}
	}
	path := filepath.Join(root, "exclusive.json")
	if err := writeExclusive(path, []byte(`{"ok":true}`)); err != nil {
		t.Fatal(err)
	}
	if writeExclusive(path, []byte(`{"ok":false}`)) == nil {
		t.Fatal("fixture output was overwritten")
	}
	var object map[string]bool
	if err := readJSON(path, &object); err != nil || !object["ok"] {
		t.Fatal("exclusive output changed")
	}
	if err := os.WriteFile(path, []byte(`{} {}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if readJSON(path, &object) == nil {
		t.Fatal("trailing JSON accepted")
	}
	first, err := randomHex(32)
	if err != nil {
		t.Fatal(err)
	}
	second, err := randomHex(32)
	if err != nil || len(first) != 64 || len(second) != 64 || first == second {
		t.Fatal("random fixture credentials are not independent")
	}
}
