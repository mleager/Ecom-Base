//go:build integration

package fixturecmd

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/email"
	"ecom/backend/internal/platform/httpserver"
	"ecom/backend/internal/testmail"
)

// Existing simulator injection is confined to this integration-only process.
// Private pipe commands cannot be reached through application HTTP routes.
type browserCheckoutSimulator struct{ interrupted *atomic.Bool }

func (s browserCheckoutSimulator) Evaluate(ctx context.Context, attempt checkout.Attempt) (checkout.Decision, error) {
	if s.interrupted.Load() {
		return "", errors.New("isolated processing interruption")
	}
	return (checkout.LocalSimulator{}).Evaluate(ctx, attempt)
}

func TestBrowserCheckoutSimulator(t *testing.T) {
	var interrupted atomic.Bool
	simulator := browserCheckoutSimulator{&interrupted}
	attempt := checkout.Attempt{ID: "a0000000-0000-4000-8000-000000000001", Scenario: "accept"}
	if decision, err := simulator.Evaluate(context.Background(), attempt); err != nil || decision != checkout.Accepted {
		t.Fatal("normal simulator result changed")
	}
	interrupted.Store(true)
	if _, err := simulator.Evaluate(context.Background(), attempt); err == nil {
		t.Fatal("interrupted simulator returned a decision")
	}
}

// This entry point exists only in the compiled integration test binary. Its
// private pipes never attach to browser traces, HTTP routes or application logs.
func TestBrowserMailAPI(t *testing.T) {
	name := os.Getenv("ECOM_BROWSER_MAIL_FIXTURE")
	if name == "" {
		t.Skip("only invoked by the owned mail browser harness")
	}
	if !namePattern.MatchString(name) {
		t.Fatal("mail fixture name rejected")
	}
	root, err := os.Getwd()
	if err != nil {
		t.Fatal("mail fixture workspace unavailable")
	}
	source, err := credentials(os.Getenv)
	if err != nil {
		t.Fatal("mail fixture credentials unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	metadata, err := inspectOrRemove(ctx, root, name, false, source)
	cancel()
	if err != nil {
		t.Fatal("mail fixture ownership rejected")
	}
	dir, err := directory(root, name)
	if err != nil {
		t.Fatal("mail fixture directory rejected")
	}
	var bundle Bundle
	if readJSON(filepath.Join(dir, "bundle.json"), &bundle) != nil || bundle.Metadata != metadata || bundle.DatabaseURL != os.Getenv("DATABASE_URL") || bundle.JWTSecret != os.Getenv("JWT_SECRET_BASE64") {
		t.Fatal("mail fixture bundle rejected")
	}
	peer, err := testmail.Start(testmail.Options{})
	if err != nil {
		t.Fatal("mail peer unavailable")
	}
	defer peer.Close()
	sender, err := peer.Sender()
	if err != nil {
		t.Fatal("mail sender unavailable")
	}
	pool, err := database.Open(context.Background(), bundle.DatabaseURL)
	if err != nil {
		t.Fatal("mail fixture database unavailable")
	}
	defer pool.Close()
	secret, err := base64.StdEncoding.DecodeString(bundle.JWTSecret)
	if err != nil {
		t.Fatal("mail fixture key rejected")
	}
	// The private harness can advance admission/JWT time to test multiple
	// deliberate actions without minute-long sleeps. Token expiry still uses
	// real PostgreSQL clock_timestamp(); production always injects time.Now.
	var authClockOffset atomic.Int64
	service, err := auth.NewService(pool, secret, func() time.Time { return time.Now().Add(time.Duration(authClockOffset.Load())) }, auth.SecurityOptions{Sender: sender, Origin: bundle.Origin})
	if err != nil {
		t.Fatal("mail fixture service unavailable")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := auth.NewHandler(service, auth.HTTPOptions{Origin: bundle.Origin, Logger: logger})
	storeService := commerce.NewService(pool)
	store := commerce.NewHandler(storeService, handler.Authenticate)
	guests := commerce.NewGuestHandler(storeService, handler.Authenticate, auth.HTTPOptions{Origin: bundle.Origin})
	var checkoutInterrupted atomic.Bool
	checkoutService, err := checkout.NewServiceWithSimulator(pool, browserCheckoutSimulator{&checkoutInterrupted})
	if err != nil {
		t.Fatal("checkout fixture service unavailable")
	}
	orders := checkout.NewHandler(checkoutService, handler.Authenticate, logger)
	guestOrders := checkout.NewGuestHandler(checkout.NewGuestService(checkoutService, sender, bundle.Origin), guests, false)
	server := httpserver.New(bundle.HTTPAddress, func(ctx context.Context) error { return database.Ready(ctx, pool) }, logger,
		handler.RoutesWith(store.Routes, orders.Routes, guests.Routes, guestOrders.Routes))
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		select {
		case err := <-done:
			if err != http.ErrServerClosed {
				t.Error("mail fixture listener failed")
			}
		case <-ctx.Done():
			_ = server.Close()
		}
	}()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 512), 1024)
	for scanner.Scan() {
		var input struct {
			ID      int    `json:"id"`
			Action  string `json:"action"`
			Account string `json:"account"`
		}
		decoder := json.NewDecoder(strings.NewReader(scanner.Text()))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.ID < 1 {
			t.Fatal("mail command rejected")
		}
		stopping := input.Action == "stop"
		account, exists := bundle.Accounts[input.Account]
		if !exists && !stopping {
			t.Fatal("mail account rejected")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		target := *source
		target.Path, target.RawPath = "/"+metadata.Name, ""
		conn, err := connect(ctx, target.String())
		if err != nil {
			cancel()
			t.Fatal("mail fixture connection failed")
		}
		owner, err := owned(ctx, conn, metadata)
		if err != nil || !owner {
			conn.Close(ctx)
			cancel()
			t.Fatal("mail command ownership rejected")
		}
		if stopping {
			conn.Close(ctx)
			cancel()
			return
		}
		result := map[string]any{"id": input.ID, "ok": true}
		switch input.Action {
		case "checkout-interrupt":
			checkoutInterrupted.Store(true)
		case "checkout-block-claim":
			// Leave T1 committed and interrupt the processing transaction before
			// its claim. This disposable fixture exercises real cancellation.
			_, err = conn.Exec(ctx, `CREATE FUNCTION public.browser_block_checkout_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'isolated checkout claim blocked'; END $$;
CREATE TRIGGER browser_block_checkout_claim BEFORE UPDATE ON payment_attempts FOR EACH ROW
WHEN (OLD.status = 'pending' AND NEW.status = 'processing') EXECUTE FUNCTION public.browser_block_checkout_claim()`)
		case "checkout-normal":
			checkoutInterrupted.Store(false)
		case "checkout-claim":
			var orderID string
			err = conn.QueryRow(ctx, `SELECT id::text FROM orders WHERE user_id=$1 AND status='pending_payment' ORDER BY created_at DESC,id DESC LIMIT 1`, account.ID).Scan(&orderID)
			if err == nil {
				checkoutInterrupted.Store(true)
				_, _ = checkoutService.Process(ctx, account.ID, orderID)
				checkoutInterrupted.Store(false)
				var observed checkout.Order
				observed, err = checkoutService.GetOrder(ctx, account.ID, orderID)
				if err == nil && (observed.Status != "pending_payment" || observed.Payment.Status != "processing") {
					err = errors.New("fixture processing claim unavailable")
				}
			}
		case "checkout-pending":
			var version int64
			var addressID string
			err = conn.QueryRow(ctx, `SELECT c.version, a.id::text FROM carts c JOIN addresses a ON a.user_id=c.user_id WHERE c.user_id=$1 ORDER BY a.id LIMIT 1`, account.ID).Scan(&version, &addressID)
			if err == nil {
				var created checkout.Result
				created, err = checkoutService.CreatePending(ctx, account.ID, rand.Text(), checkout.Request{CartVersion: version, ShippingAddressID: addressID, PaymentScenario: "accept"})
				if err == nil {
					result["order_id"] = created.Order.ID
				}
			}
		case "checkout-rollback":
			// Fail the final idempotency insert after reservations/snapshots/cart
			// updates. PostgreSQL rolls the complete owned-fixture T1 back.
			_, err = conn.Exec(ctx, `CREATE FUNCTION public.browser_checkout_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated checkout rollback'; END $$;
CREATE CONSTRAINT TRIGGER browser_checkout_failure AFTER INSERT ON checkout_idempotency DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.browser_checkout_failure()`)
		case "checkout-restore":
			_, err = conn.Exec(ctx, `DROP TRIGGER browser_checkout_failure ON checkout_idempotency; DROP FUNCTION public.browser_checkout_failure()`)
		case "mail", "proposed-mail":
			mailbox := account.Email
			if input.Action == "proposed-mail" {
				mailbox = "changed-" + account.ID + "@example.test"
			}
			messages := peer.Messages(mailbox)
			if len(messages) > 10 {
				messages = messages[len(messages)-10:]
			}
			if messages == nil {
				messages = []email.Message{}
			}
			result["messages"] = messages
		case "allow-resend":
			_, err = conn.Exec(ctx, `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '61 seconds' WHERE user_id=$1 AND purpose='verify_email'`, account.ID)
		case "expire-token":
			_, err = conn.Exec(ctx, `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND purpose='verify_email'`, account.ID)
		case "allow-change":
			_, err = conn.Exec(ctx, `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '61 seconds' WHERE user_id=$1 AND purpose='email_change_old'`, account.ID)
		case "expire-change":
			_, err = conn.Exec(ctx, `UPDATE email_change_requests SET created_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND state='pending'`, account.ID)
		case "expire-reset":
			_, err = conn.Exec(ctx, `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND purpose='reset_password'`, account.ID)
		case "mail-fail":
			peer.SetDropAck(true)
		case "mail-restore":
			peer.SetDropAck(false)
		case "advance-auth-clock":
			authClockOffset.Add(int64(61 * time.Second))
		default:
			conn.Close(ctx)
			cancel()
			t.Fatal("mail action rejected")
		}
		conn.Close(ctx)
		cancel()
		if err != nil {
			t.Fatal("mail command failed")
		}
		encoded, err := json.Marshal(result)
		if err != nil || len(encoded) > 64*1024 {
			t.Fatal("mail result bounds exceeded")
		}
		if _, err = os.Stdout.Write(append(encoded, '\n')); err != nil {
			t.Fatal("mail pipe failed")
		}
	}
	if scanner.Err() != nil {
		t.Fatal("mail pipe input failed")
	}
}
