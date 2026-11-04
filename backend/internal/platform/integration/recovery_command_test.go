//go:build integration

package integration

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"ecom/backend/internal/checkout"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/reconcilecmd"
)

func recoveryEnvironment(f *testDatabase, application string) []string {
	values := []string{}
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		upper := strings.ToUpper(key)
		if strings.HasPrefix(upper, "ECOM_") || strings.Contains(upper, "PASSWORD") || strings.Contains(upper, "SECRET") || upper == "DATABASE_URL" || upper == "APP_ENV" || upper == "FRONTEND_ORIGIN" || upper == "HTTP_ADDR" {
			continue
		}
		values = append(values, value)
	}
	connection, err := url.Parse(f.pool.Config().ConnConfig.ConnString())
	if err != nil {
		panic("test fixture did not use a PostgreSQL URL")
	}
	query := connection.Query()
	query.Set("application_name", application)
	connection.RawQuery = query.Encode()
	return append(values, "APP_ENV=local", "DATABASE_URL="+connection.String())
}

func readRecoverySummary(t *testing.T, data []byte) checkout.RecoveryReport {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	for {
		var row struct {
			Event string `json:"event"`
			checkout.RecoveryReport
		}
		if err := decoder.Decode(&row); err != nil {
			t.Fatal("missing JSON recovery summary")
		}
		if row.Event == "summary" {
			return row.RecoveryReport
		}
	}
}

func TestRecoveryCommand(t *testing.T) {
	f := newTestDatabase(t)
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate repository")
	}
	binary := filepath.Join(t.TempDir(), "reconcile.exe")
	build := exec.CommandContext(f.ctx, "go", "build", "-o", binary, "./backend/cmd/reconcile")
	build.Dir = filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("native command build failed: %v %s", err, output)
	}
	run := func(args ...string) ([]byte, string, error) {
		command := exec.CommandContext(f.ctx, binary, args...)
		command.Env = recoveryEnvironment(f, "ecom_recovery_command")
		var output, stderr bytes.Buffer
		command.Stdout, command.Stderr = &output, &stderr
		err := command.Run()
		return output.Bytes(), stderr.String(), err
	}
	product := seedCheckoutProduct(t, f, 5, 100)
	_, order := pendingOrder(t, f, "reject", checkoutLine{product, 1})
	expireRecoveryOrder(t, f, order.ID, time.Now().UTC().Add(-time.Hour))
	before := recoverySnapshot(t, f)
	output, stderr, err := run()
	if err != nil || stderr != "" || readRecoverySummary(t, output).Mode != "dry-run" || before != recoverySnapshot(t, f) {
		t.Fatal("default command was not read-only or required unrelated JWT settings")
	}
	output, stderr, err = run("--apply", "--limit", "1")
	if err != nil || stderr != "" || readRecoverySummary(t, output).Settled != 1 {
		t.Fatal("command did not recover rejected payment")
	}
	assertOrderState(t, f, order.ID, "payment_failed", "failed", "released", 2)
	assertStock(t, f, product, 5, 0)
	before = recoverySnapshot(t, f)
	output, _, err = run("--apply")
	if err != nil || readRecoverySummary(t, output).Visited != 0 || before != recoverySnapshot(t, f) {
		t.Fatal("command rerun changed completed data")
	}
	if _, stderr, err = run("--apply", "--dry-run"); err == nil || !strings.Contains(stderr, "choose only one") {
		t.Fatal("invalid modes did not exit unsuccessfully")
	}
	if _, stderr, err = run("--limit=private-secret"); err == nil || strings.Contains(stderr, "private-secret") {
		t.Fatal("invalid arguments leaked input or exited successfully")
	}
	_, retryOrder := pendingOrder(t, f, "accept", checkoutLine{product, 1})
	expireRecoveryOrder(t, f, retryOrder.ID, time.Now().UTC().Add(-time.Hour))
	if _, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION command_private_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-database-detail'; END $$; CREATE TRIGGER command_private_failure BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION command_private_failure()`); err != nil {
		t.Fatal(err)
	}
	output, stderr, err = run("--apply")
	if err == nil || readRecoverySummary(t, output).Failed != 1 || strings.Contains(string(output)+stderr, "private-database-detail") {
		t.Fatal("command exposed a SQL error or failed to report unsuccessful recovery")
	}
	if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER command_private_failure ON payment_attempts; DROP FUNCTION command_private_failure()`); err != nil {
		t.Fatal(err)
	}
	if _, _, err = run("--apply"); err != nil {
		t.Fatal("command could not recover after SQL fault removal")
	}
	if _, err := f.migrator.Exec(f.ctx, `UPDATE inventory_reservations SET status='consumed'`); err != nil {
		t.Fatal(err)
	}
	output, _, err = run("--dry-run")
	if err == nil || readRecoverySummary(t, output).DiagnosticCount == 0 {
		t.Fatal("inconsistent terminal data did not produce nonzero command exit")
	}
}

// These pause controls live exclusively in the test executable. They exercise
// the real command/service without adding production crash flags or API hooks.
type recoveryPauseWriter struct{ phase string }

func (writer recoveryPauseWriter) Write(data []byte) (int, error) {
	n, err := os.Stdout.Write(data)
	if err != nil {
		return n, err
	}
	var event checkout.RecoveryEvent
	if json.Unmarshal(data, &event) == nil && ((writer.phase == "after_claim" && event.Event == "claimed") || (writer.phase == "after_t2" && event.Event == "settled")) {
		<-make(chan struct{})
	}
	return n, nil
}

func TestRecoveryProcessHelper(t *testing.T) {
	phase := os.Getenv("ECOM_RECOVERY_CHILD_MODE")
	if phase == "" {
		return
	}
	ctx := context.Background()
	if phase == "before_claim" {
		pool, err := database.Open(ctx, os.Getenv("DATABASE_URL"))
		if err != nil {
			t.Fatal("child could not initialize database")
		}
		defer pool.Close()
		result, err := checkout.NewService(pool).CreatePending(ctx, os.Getenv("ECOM_RECOVERY_CHILD_USER"), "crashed-t1", checkout.Request{CartVersion: 1, ShippingAddressID: os.Getenv("ECOM_RECOVERY_CHILD_ADDRESS"), PaymentScenario: "accept"})
		if err != nil {
			t.Fatal("child T1 failed")
		}
		if err := json.NewEncoder(os.Stdout).Encode(checkout.RecoveryEvent{Event: "t1_committed", OrderID: result.Order.ID}); err != nil {
			t.Fatal("child audit failed")
		}
		<-make(chan struct{})
	}
	if err := reconcilecmd.Run(ctx, []string{"--apply"}, os.Getenv, recoveryPauseWriter{phase}, io.Discard); err != nil {
		t.Fatal("child command failed")
	}
}

func TestRecoveryProcessCrash(t *testing.T) {
	for _, phase := range []string{"before_claim", "after_claim", "during_t2", "after_t2"} {
		t.Run(phase, func(t *testing.T) {
			f := newTestDatabase(t)
			a, b := seedCheckoutProduct(t, f, 5, 100), seedCheckoutProduct(t, f, 5, 100)
			customer := seedCheckoutCustomer(t, f, checkoutLine{a, 1}, checkoutLine{b, 1})
			orderID := ""
			if phase != "before_claim" {
				result, err := checkout.NewService(f.pool).CreatePending(f.ctx, customer.user, "crashed-t1", customer.request)
				if err != nil {
					t.Fatal(err)
				}
				orderID = result.Order.ID
				expireRecoveryOrder(t, f, orderID, time.Now().UTC().Add(-time.Hour))
			}
			var release func()
			if phase == "during_t2" {
				ids := []string{a, b}
				sort.Strings(ids)
				statement := fmt.Sprintf(`CREATE FUNCTION pause_recovery_t2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id='%s'::uuid THEN PERFORM pg_advisory_xact_lock(1942,8675309); END IF; RETURN NEW; END $$; CREATE TRIGGER pause_recovery_t2 BEFORE UPDATE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION pause_recovery_t2();`, ids[1])
				if _, err := f.migrator.Exec(f.ctx, statement); err != nil {
					t.Fatal(err)
				}
				tx, err := f.migrator.Begin(f.ctx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := tx.Exec(f.ctx, `SELECT pg_advisory_xact_lock(1942,8675309)`); err != nil {
					t.Fatal(err)
				}
				release = func() { _ = tx.Rollback(context.Background()) }
				t.Cleanup(release)
			}
			application := "ecom_crash_" + strings.ReplaceAll(checkoutID(t), "-", "")
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(f.ctx, 15*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestRecoveryProcessHelper$")
			command.Env = append(recoveryEnvironment(f, application), "ECOM_RECOVERY_CHILD_MODE="+phase, "ECOM_RECOVERY_CHILD_USER="+customer.user, "ECOM_RECOVERY_CHILD_ADDRESS="+customer.address)
			stdout, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			command.Stderr = io.Discard
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = command.Process.Kill() })
			events := make(chan checkout.RecoveryEvent, 10)
			go func() {
				defer close(events)
				scanner := bufio.NewScanner(stdout)
				for scanner.Scan() {
					var event checkout.RecoveryEvent
					if json.Unmarshal(scanner.Bytes(), &event) == nil {
						events <- event
					}
				}
			}()
			expected := "claimed"
			if phase == "before_claim" {
				expected = "t1_committed"
			} else if phase == "after_t2" {
				expected = "settled"
			}
			for {
				select {
				case event, open := <-events:
					if !open {
						t.Fatal("child ended before crash boundary")
					}
					if event.Event == expected {
						orderID = event.OrderID
						goto ready
					}
				case <-ctx.Done():
					t.Fatal("child did not reach crash boundary")
				}
			}
		ready:
			if phase == "during_t2" {
				waitRecoveryBackend(t, f, application, true)
			}
			if err := command.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := command.Wait(); err == nil {
				t.Fatal("killed child exited successfully")
			}
			if release != nil {
				release()
			}
			waitRecoveryBackend(t, f, application, false)
			if phase == "before_claim" {
				expireRecoveryOrder(t, f, orderID, time.Now().UTC().Add(-time.Hour))
				assertOrderState(t, f, orderID, "pending_payment", "pending", "active", 1)
			} else if phase != "after_t2" {
				assertOrderState(t, f, orderID, "pending_payment", "processing", "active", 1)
				assertStock(t, f, a, 5, 1)
				assertStock(t, f, b, 5, 1)
			}
			if phase == "during_t2" {
				if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER pause_recovery_t2 ON inventory_reservations; DROP FUNCTION pause_recovery_t2()`); err != nil {
					t.Fatal(err)
				}
			}
			var output bytes.Buffer
			values := map[string]string{}
			for _, value := range recoveryEnvironment(f, "ecom_recovery_restart") {
				key, content, _ := strings.Cut(value, "=")
				values[key] = content
			}
			if err := reconcilecmd.Run(f.ctx, []string{"--apply"}, func(key string) string { return values[key] }, &output, io.Discard); err != nil {
				t.Fatal(err)
			}
			assertOrderState(t, f, orderID, "confirmed", "succeeded", "consumed", 2)
			assertStock(t, f, a, 4, 0)
			assertStock(t, f, b, 4, 0)
			before := recoverySnapshot(t, f)
			if report, err := checkout.NewService(f.pool).Recover(f.ctx, 100, nil); err != nil || report.Visited != 0 || before != recoverySnapshot(t, f) {
				t.Fatal("post-crash retry changed settled data")
			}
		})
	}
}

func waitRecoveryBackend(t *testing.T, f *testDatabase, application string, blocked bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var exists bool
		if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND (NOT $2::boolean OR wait_event_type='Lock' AND wait_event='advisory'))`, application, blocked).Scan(&exists); err != nil {
			t.Fatal("could not observe child transaction")
		}
		if exists == blocked {
			return
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("child transaction did not reach expected database boundary")
		}
	}
}
