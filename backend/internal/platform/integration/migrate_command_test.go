//go:build integration

package integration

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"ecom/backend"
	"ecom/backend/internal/migratecmd"
	"ecom/backend/internal/platform/database"

	"github.com/pressly/goose/v3"
)

type migrateOutput struct {
	rows    []migratecmd.Migration
	summary *migratecmd.Summary
}

func (o migrateOutput) versions(event string) []int64 {
	var result []int64
	for _, row := range o.rows {
		if row.Event == event {
			result = append(result, row.Version)
		}
	}
	return result
}

func readMigrateOutput(t *testing.T, data []byte) migrateOutput {
	t.Helper()
	var output migrateOutput
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		var probe struct {
			Event string `json:"event"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &probe); err != nil {
			t.Fatalf("migrate output is not JSON lines: %q", scanner.Text())
		}
		if probe.Event == "summary" {
			var summary migratecmd.Summary
			if err := json.Unmarshal(scanner.Bytes(), &summary); err != nil {
				t.Fatal(err)
			}
			output.summary = &summary
			continue
		}
		var row migratecmd.Migration
		if err := json.Unmarshal(scanner.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		output.rows = append(output.rows, row)
	}
	return output
}

// runMigrate runs the command in process against f with the migrator role.
func runMigrate(t *testing.T, f *testDatabase, fsys fs.FS, command string) (migrateOutput, error) {
	t.Helper()
	env := map[string]string{"APP_ENV": "local", "DATABASE_URL": f.migratorURL}
	var stdout, help bytes.Buffer
	err := migratecmd.RunFS(f.ctx, fsys, []string{command}, func(key string) string { return env[key] }, &stdout, &help)
	if help.Len() > 0 {
		t.Fatal("migrate wrote help output")
	}
	return readMigrateOutput(t, stdout.Bytes()), err
}

// migrationSet copies the embedded migrations up to through and adds extra files.
func migrationSet(t *testing.T, through int64, extra map[string]string) fs.FS {
	t.Helper()
	set := fstest.MapFS{}
	entries, err := fs.ReadDir(backend.Migrations(), ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		version, err := goose.NumericComponent(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		if version > through {
			continue
		}
		data, err := fs.ReadFile(backend.Migrations(), entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		set[entry.Name()] = &fstest.MapFile{Data: data}
	}
	for name, body := range extra {
		set[name] = &fstest.MapFile{Data: []byte(body)}
	}
	return set
}

// embeddedLatest is the newest migration in this build.
func embeddedLatest(t *testing.T) int64 {
	t.Helper()
	entries, err := fs.ReadDir(backend.Migrations(), ".")
	if err != nil || len(entries) == 0 {
		t.Fatal("no embedded migrations")
	}
	version, err := goose.NumericComponent(entries[len(entries)-1].Name())
	if err != nil {
		t.Fatal(err)
	}
	return version
}

func sequence(from, to int64) []int64 {
	var result []int64
	for v := from; v <= to; v++ {
		result = append(result, v)
	}
	return result
}

func equalVersions(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func relationExists(t *testing.T, f *testDatabase, name string) bool {
	t.Helper()
	var exists bool
	if err := f.migrator.QueryRow(f.ctx, `SELECT to_regclass($1) IS NOT NULL`, name).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	return exists
}

// versionRows counts goose rows per applied version, including version 0.
func versionRows(t *testing.T, f *testDatabase) map[int64]int {
	t.Helper()
	rows, err := f.migrator.Query(f.ctx, `SELECT version_id, count(*) FROM public.goose_db_version WHERE is_applied GROUP BY version_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := map[int64]int{}
	for rows.Next() {
		var version int64
		var count int
		if err := rows.Scan(&version, &count); err != nil {
			t.Fatal(err)
		}
		result[version] = count
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestMigrateCommand(t *testing.T) {
	f := newEmptyDatabase(t)
	latest := embeddedLatest(t)

	t.Run("status is read-only on a fresh database", func(t *testing.T) {
		output, err := runMigrate(t, f, backend.Migrations(), "status")
		if err != nil || output.summary == nil {
			t.Fatalf("status failed: %v", err)
		}
		if s := *output.summary; s.Version != 0 || s.Pending != int(latest) || s.Ready || s.Latest != latest {
			t.Fatalf("fresh status summary = %+v", s)
		}
		if !equalVersions(output.versions("migration"), sequence(1, latest)) {
			t.Fatalf("status rows = %v", output.versions("migration"))
		}
		if relationExists(t, f, "public.goose_db_version") {
			t.Fatal("status created the version table")
		}
	})

	t.Run("up applies every migration", func(t *testing.T) {
		output, err := runMigrate(t, f, backend.Migrations(), "up")
		if err != nil || output.summary == nil {
			t.Fatalf("up failed: %v", err)
		}
		if s := *output.summary; s.Version != latest || s.Applied != int(latest) || s.Pending != 0 || !s.Ready {
			t.Fatalf("up summary = %+v", s)
		}
		if !equalVersions(output.versions("applied"), sequence(1, latest)) {
			t.Fatalf("applied = %v", output.versions("applied"))
		}
		if err := database.Ready(f.ctx, f.pool); err != nil {
			t.Fatalf("readiness after up: %v", err)
		}
	})

	t.Run("second up changes nothing", func(t *testing.T) {
		before := versionRows(t, f)
		output, err := runMigrate(t, f, backend.Migrations(), "up")
		if err != nil || output.summary == nil || output.summary.Applied != 0 || len(output.rows) != 0 || output.summary.Version != latest {
			t.Fatalf("second up = %+v, %v", output.summary, err)
		}
		after := versionRows(t, f)
		if len(after) != int(latest)+1 || len(before) != len(after) {
			t.Fatalf("version rows changed: before %v after %v", before, after)
		}
		status, err := runMigrate(t, f, backend.Migrations(), "status")
		if err != nil || status.summary.Pending != 0 || status.summary.Version != latest {
			t.Fatalf("status after up = %+v, %v", status.summary, err)
		}
	})

	t.Run("built binary", func(t *testing.T) {
		_, file, _, ok := runtime.Caller(0)
		if !ok {
			t.Fatal("could not locate repository")
		}
		binary := filepath.Join(t.TempDir(), "migrate.exe")
		build := exec.CommandContext(f.ctx, "go", "build", "-o", binary, "./backend/cmd/migrate")
		build.Dir = filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("migrate build failed: %v %s", err, output)
		}
		environment := []string{}
		for _, value := range os.Environ() {
			key, _, _ := strings.Cut(value, "=")
			upper := strings.ToUpper(key)
			if strings.HasPrefix(upper, "ECOM_") || strings.HasPrefix(upper, "GOOSE_") || strings.Contains(upper, "PASSWORD") || upper == "DATABASE_URL" || upper == "APP_ENV" {
				continue
			}
			environment = append(environment, value)
		}
		environment = append(environment, "APP_ENV=local", "DATABASE_URL="+f.migratorURL)
		password := os.Getenv("ECOM_TEST_MIGRATOR_PASSWORD")
		run := func(args ...string) ([]byte, string, error) {
			command := exec.CommandContext(f.ctx, binary, args...)
			command.Env = environment
			var stdout, stderr bytes.Buffer
			command.Stdout, command.Stderr = &stdout, &stderr
			err := command.Run()
			if strings.Contains(stdout.String()+stderr.String(), password) {
				t.Fatal("migrate printed the database password")
			}
			return stdout.Bytes(), stderr.String(), err
		}
		stdout, stderr, err := run("up")
		if output := readMigrateOutput(t, stdout); err != nil || stderr != "" || output.summary == nil || output.summary.Applied != 0 || output.summary.Version != latest {
			t.Fatalf("binary up: %v %q %+v", err, stderr, output.summary)
		}
		if _, stderr, err := run("down"); err == nil || !strings.Contains(stderr, "up or status") {
			t.Fatalf("binary accepted down: %v %q", err, stderr)
		}
	})
}

func TestMigrateConcurrentRuns(t *testing.T) {
	f := newEmptyDatabase(t)
	latest := embeddedLatest(t)
	stdouts := make([]bytes.Buffer, 2)
	errs := make([]error, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	env := map[string]string{"APP_ENV": "local", "DATABASE_URL": f.migratorURL}
	for i := range stdouts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs[i] = migratecmd.RunFS(f.ctx, backend.Migrations(), []string{"up"}, func(key string) string { return env[key] }, &stdouts[i], &bytes.Buffer{})
		}()
	}
	close(start)
	wg.Wait()

	seen := map[int64]int{}
	for i := range stdouts {
		output := readMigrateOutput(t, stdouts[i].Bytes())
		if errs[i] != nil || output.summary == nil || output.summary.Version != latest {
			t.Fatalf("run %d: %v %+v", i, errs[i], output.summary)
		}
		for _, version := range output.versions("applied") {
			seen[version]++
		}
	}
	for _, version := range sequence(1, latest) {
		if seen[version] != 1 {
			t.Fatalf("migration %d applied %d times across both runs (%v)", version, seen[version], seen)
		}
	}
	rows := versionRows(t, f)
	for _, version := range sequence(0, latest) {
		if rows[version] != 1 {
			t.Fatalf("version %d has %d applied rows: %v", version, rows[version], rows)
		}
	}
}

func TestMigrateFailureKeepsVersion(t *testing.T) {
	f := newEmptyDatabase(t)
	latest := embeddedLatest(t)
	name := fmt.Sprintf("%05d_broken.sql", latest+1)
	broken := migrationSet(t, latest, map[string]string{name: `-- +goose Up
CREATE TABLE migrate_failure_probe (id integer);
SELECT 1 / 0;
`})
	output, err := runMigrate(t, f, broken, "up")
	if want := fmt.Sprintf("migration %d failed; schema version is %d", latest+1, latest); err == nil || err.Error() != want {
		t.Fatalf("broken migration error = %v, want %q", err, want)
	}
	if !equalVersions(output.versions("applied"), sequence(1, latest)) || !equalVersions(output.versions("failed"), []int64{latest + 1}) {
		t.Fatalf("output rows = %+v", output.rows)
	}
	if failed := output.rows[len(output.rows)-1]; failed.Error != "SQLSTATE 22012: division by zero" || failed.Source != name {
		t.Fatalf("failed row = %+v", failed)
	}
	if output.summary == nil || output.summary.Version != latest || !output.summary.Ready {
		t.Fatalf("failure summary = %+v", output.summary)
	}
	if relationExists(t, f, "public.migrate_failure_probe") {
		t.Fatal("failed migration was not rolled back")
	}
	if rows := versionRows(t, f); rows[latest+1] != 0 {
		t.Fatal("failed migration was recorded")
	}
	if err := database.Ready(f.ctx, f.pool); err != nil {
		t.Fatalf("readiness after failed migration: %v", err)
	}
	if output, err := runMigrate(t, f, backend.Migrations(), "up"); err != nil || output.summary.Applied != 0 {
		t.Fatalf("rerun with the good build: %+v %v", output.summary, err)
	}
}

// Readiness passes at the minimum version and above, and fails below it.
func TestReadinessMinimumSchemaVersion(t *testing.T) {
	f := newEmptyDatabase(t)
	minimum, latest := database.MinSchemaVersion, embeddedLatest(t)

	older, err := runMigrate(t, f, migrationSet(t, minimum-1, nil), "up")
	if err != nil || older.summary.Version != minimum-1 || older.summary.Ready {
		t.Fatalf("up to %d: %+v %v", minimum-1, older.summary, err)
	}
	if err := database.Ready(f.ctx, f.pool); err == nil {
		t.Fatalf("readiness passed at version %d", minimum-1)
	}

	if output, err := runMigrate(t, f, migrationSet(t, minimum, nil), "up"); err != nil || output.summary.Version != minimum {
		t.Fatalf("up to %d: %+v %v", minimum, output.summary, err)
	}
	if err := database.Ready(f.ctx, f.pool); err != nil {
		t.Fatalf("readiness failed at version %d: %v", minimum, err)
	}

	newer := migrationSet(t, latest, map[string]string{fmt.Sprintf("%05d_forward.sql", latest+1): `-- +goose Up
CREATE TABLE migrate_forward_probe (id integer);
`})
	if output, err := runMigrate(t, f, newer, "up"); err != nil || output.summary.Version != latest+1 {
		t.Fatalf("up to %d: %+v %v", latest+1, output.summary, err)
	}
	if err := database.Ready(f.ctx, f.pool); err != nil {
		t.Fatalf("readiness failed at version %d: %v", latest+1, err)
	}

	// An older build against a newer schema applies nothing and reports it.
	output, err := runMigrate(t, f, backend.Migrations(), "up")
	if err != nil || output.summary.Applied != 0 || output.summary.Version != latest+1 || !output.summary.Ready {
		t.Fatalf("older build up: %+v %v", output.summary, err)
	}
	status, err := runMigrate(t, f, backend.Migrations(), "status")
	if err != nil || status.summary.Version != latest+1 || status.summary.Latest != latest {
		t.Fatalf("older build status: %+v %v", status.summary, err)
	}
	if last := status.rows[len(status.rows)-1]; last.Version != latest+1 || last.State != "unknown" {
		t.Fatalf("newer migration row = %+v", last)
	}
}
