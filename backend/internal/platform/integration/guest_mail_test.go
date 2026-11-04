//go:build integration

package integration

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/email"
	"ecom/backend/internal/testmail"
)

func guestProofToken(t *testing.T, message email.Message) string {
	t.Helper()
	_, tail, found := strings.Cut(message.Body, authTestOrigin+"/guest/recover#token=")
	token := strings.Fields(tail)
	if !found || len(token) == 0 || len(token[0]) != 43 {
		t.Fatal("missing trusted-origin guest proof link")
	}
	return token[0]
}

func confirmGuestToken(t *testing.T, api authAPI, token string, cookies ...*http.Cookie) *http.Cookie {
	t.Helper()
	response := guestCheckoutCall(t, api, "POST", "/recovery-confirmations", fmt.Sprintf(`{"token":%q}`, token), "", 200, cookies...)
	if len(response.cookies) != 1 {
		t.Fatal("confirmation did not issue a single scoped cookie")
	}
	cookie := response.cookies[0]
	if cookie.Name != "ecom_guest_recovery" || !cookie.HttpOnly || cookie.Path != "/api/v1/guest" || cookie.SameSite != http.SameSiteStrictMode || cookie.Domain != "" || strings.Contains(string(response.body), cookie.Value) {
		t.Fatal("scoped cookie policy differs")
	}
	return cookie
}

func TestGuestRecoveryTLSAndScopes(t *testing.T) {
	f := newTestDatabase(t)
	peer, err := testmail.Start(testmail.Options{Mode: "tls"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(peer.Close)
	sender, err := peer.Sender()
	if err != nil {
		t.Fatal(err)
	}
	api := guestCheckoutAPI(t, f, f.pool, sender)
	quiet := guestCheckoutAPI(t, f, f.pool, email.Disabled{})
	product := seedCheckoutProduct(t, f, 10, 100)
	const contact = "guest@example.test"
	p := makeGuestPurchase(t, api, product, "accept", contact)
	p.prepare(t, api, 201)
	other := makeGuestPurchase(t, api, product, "reject", contact)
	other.prepare(t, api, 201)
	pool, fault := newCommitFaultPool(t, f, commitDropAfter)
	pending := decodeResponse[checkout.Order](t, other.place(t, guestCheckoutAPI(t, f, pool, email.Disabled{}), 200))
	awaitCommitFault(t, fault)
	guestCheckoutCall(t, quiet, "POST", "/recovery-requests", fmt.Sprintf(`{"contact_email":%q,"checkout_intent_id":%q}`, contact, p.intent), "", 503)

	bodies := []string{
		fmt.Sprintf(`{"contact_email":%q,"checkout_intent_id":%q}`, contact, p.intent),
		fmt.Sprintf(`{"contact_email":%q,"checkout_intent_id":%q}`, contact, p.intent),
		fmt.Sprintf(`{"contact_email":"wrong@example.test","checkout_intent_id":%q}`, p.intent),
		fmt.Sprintf(`{"contact_email":%q,"checkout_intent_id":%q}`, contact, checkoutID(t)),
	}
	var requests sync.WaitGroup
	responses := make([]authResponse, len(bodies))
	errs := make([]error, len(bodies))
	durations := make([]time.Duration, len(bodies))
	for i, body := range bodies {
		requests.Go(func() {
			start := time.Now()
			responses[i], errs[i] = doGuestCheckout(api, "POST", "/recovery-requests", body, "")
			durations[i] = time.Since(start)
		})
	}
	requests.Wait()
	for i, response := range responses {
		if errs[i] != nil || response.status != 202 || string(response.body) != string(responses[0].body) || len(response.cookies) != 0 || durations[i] < 8*time.Second {
			t.Fatalf("mail request %d disclosed eligibility or missed the timing floor", i)
		}
	}
	messages := peer.Messages(contact)
	if len(messages) != 2 || len(peer.Messages("wrong@example.test")) != 0 {
		t.Fatal("unexpected isolated TLS delivery count")
	}
	expired, fresh := guestProofToken(t, messages[0]), guestProofToken(t, messages[1])
	digest, err := commerce.GuestTokenDigest(expired)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.migrator.Exec(f.ctx, `UPDATE guest_recovery_tokens SET created_at=clock_timestamp()-interval '16 minutes',
 expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, digest); err != nil {
		t.Fatal(err)
	}
	guestCheckoutCall(t, api, "POST", "/recovery-confirmations", fmt.Sprintf(`{"token":%q}`, expired), "", 400)
	// Scanner-like GET cannot redeem a proof from the URL.
	guestCheckoutCall(t, api, "GET", "/recovery-confirmations", "", "", 405)
	grant := confirmGuestToken(t, api, fresh, other.cookie)
	guestCheckoutCall(t, api, "POST", "/recovery-confirmations", fmt.Sprintf(`{"token":%q}`, fresh), "", 400)
	guestCheckoutCall(t, api, "GET", "/recovery-access", "", "", 200, grant)
	guestCheckoutCall(t, api, "GET", "/checkout-intents/"+p.intent, "", "", 200, other.cookie, grant)
	guestCheckoutCall(t, api, "GET", "/checkout-intents/"+p.intent, "", "", 200, &http.Cookie{Name: "ecom_guest", Value: "unrecognized"}, grant)
	guestCheckoutCall(t, api, "GET", "/checkout-intents/"+p.intent, "", "", 401, other.cookie, other.cookie, grant)
	guestCheckoutCall(t, api, "GET", "/checkout-intents/"+other.intent, "", "", 404, grant)
	guestCheckoutCall(t, api, "GET", "/orders/"+pending.ID, "", "", 404, grant)
	guestCheckoutCall(t, api, "GET", "/orders", "", "", 401, grant)
	guestCheckoutCall(t, api, "GET", "/cart", "", "", 401, grant)
	guestCheckoutCall(t, api, "POST", "/checkout-intents", p.prep, p.key, 401, grant)
	guestCheckoutCall(t, api, "POST", "/checkout", strings.Replace(p.submit, "accept", "reject", 1), p.key, 409, grant)
	peer.SetDropAck(true)
	order := decodeResponse[checkout.Order](t, guestCheckoutCall(t, api, "POST", "/checkout", p.submit, p.key, 201, grant))
	peer.SetDropAck(false)
	if order.Status != "confirmed" {
		t.Fatal("receipt delivery error changed settlement")
	}
	guestCheckoutCall(t, api, "GET", "/orders/"+order.ID, "", "", 200, grant)
	guestCheckoutCall(t, api, "GET", "/orders/"+order.ID+"/payments", "", "", 200, grant)
	guestCheckoutCall(t, api, "POST", "/recovery-requests", fmt.Sprintf(`{"contact_email":%q,"order_id":%q}`, contact, pending.ID), "", 202)
	messages = peer.Messages(contact)
	orderGrant := confirmGuestToken(t, api, guestProofToken(t, messages[len(messages)-1]), grant, other.cookie)
	guestCheckoutCall(t, api, "GET", "/recovery-access", "", "", 401, grant)
	guestCheckoutCall(t, api, "GET", "/orders/"+order.ID, "", "", 404, orderGrant)
	guestCheckoutCall(t, api, "GET", "/checkout-intents/"+other.intent, "", "", 404, orderGrant)
	cancelled := decodeResponse[checkout.Order](t, guestCheckoutCall(t, api, "POST", "/orders/"+pending.ID+"/cancel", "", "", 200, orderGrant))
	if cancelled.Status != "cancelled" {
		t.Fatal("scoped cancellation did not release pending order")
	}
	guestCheckoutCall(t, api, "DELETE", "/recovery-access", "", "", 204, orderGrant, other.cookie)
	guestCheckoutCall(t, api, "GET", "/recovery-access", "", "", 401, orderGrant)
	guestCheckoutCall(t, api, "GET", "/orders/"+pending.ID, "", "", 200, other.cookie)
	assertCheckoutIntegrity(t, f)
}

func TestGuestProofLostCommit(t *testing.T) {
	for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter} {
		t.Run(fmt.Sprint(mode), func(t *testing.T) {
			f := newTestDatabase(t)
			api := guestCheckoutAPI(t, f, f.pool, email.Disabled{})
			product := seedCheckoutProduct(t, f, 10, 100)
			p := makeGuestPurchase(t, api, product, "accept", "guest@example.test")
			p.prepare(t, api, 201)
			token, digest, err := commerce.NewGuestToken()
			if err != nil {
				t.Fatal(err)
			}
			emailHash := sha256.Sum256([]byte("guest@example.test"))
			_, err = f.migrator.Exec(f.ctx, `INSERT INTO guest_recovery_tokens(id,guest_id,intent_id,email_digest,token_hash,expires_at)
 SELECT $1,guest_id,id,$2,$3,clock_timestamp()+interval '15 minutes' FROM guest_checkout_intents WHERE id=$4`,
				checkoutID(t), emailHash[:], digest, p.intent)
			if err != nil {
				t.Fatal(err)
			}
			pool, fault := newCommitFaultPool(t, f, mode)
			response := guestCheckoutCall(t, guestCheckoutAPI(t, f, pool, email.Disabled{}), "POST", "/recovery-confirmations",
				fmt.Sprintf(`{"token":%q}`, token), "", 503)
			if len(response.cookies) != 0 {
				t.Fatal("uncertain proof confirmation published an unconfirmed cookie")
			}
			awaitCommitFault(t, fault)
			if mode == commitDropBefore {
				confirmGuestToken(t, api, token)
			} else {
				guestCheckoutCall(t, api, "POST", "/recovery-confirmations", fmt.Sprintf(`{"token":%q}`, token), "", 400)
			}
		})
	}
}

// This separate opt-in sends exactly one proof to the configured controlled mailbox.
func TestControlledGuestMailboxSMTP(t *testing.T) {
	if os.Getenv("ECOM_GUEST_SMTP_SMOKE") != "1" {
		t.Skip("requires explicit guest mailbox smoke opt-in")
	}
	recipient := os.Getenv("ECOM_MAIL_TEST_RECIPIENT")
	if recipient == "" {
		t.Fatal("controlled recipient is missing")
	}
	sender, err := email.New(email.Config{Mode: os.Getenv("MAIL_MODE"), Host: os.Getenv("SMTP_HOST"), Port: os.Getenv("SMTP_PORT"),
		TLSMode: os.Getenv("SMTP_TLS_MODE"), Username: os.Getenv("SMTP_USERNAME"), Password: os.Getenv("SMTP_PASSWORD"), From: os.Getenv("MAIL_FROM")})
	if err != nil || !sender.Enabled() {
		t.Fatal("private SMTP configuration is invalid or disabled")
	}
	f := newTestDatabase(t)
	capture := &smokeSender{sender: sender}
	api := guestCheckoutAPI(t, f, f.pool, capture)
	product := seedCheckoutProduct(t, f, 10, 100)
	p := makeGuestPurchase(t, api, product, "accept", recipient)
	p.prepare(t, api, 201)
	guestCheckoutCall(t, api, "POST", "/recovery-requests", fmt.Sprintf(`{"contact_email":%q,"checkout_intent_id":%q}`, recipient, p.intent), "", 202)
	if len(capture.captured.messages) != 1 {
		t.Fatal("external SMTP acceptance was not confirmed; a message may still arrive")
	}
	token := guestProofToken(t, capture.captured.messages[0])
	grant := confirmGuestToken(t, api, token)
	guestCheckoutCall(t, api, "GET", "/checkout-intents/"+p.intent, "", "", 200, grant)
	guestCheckoutCall(t, api, "POST", "/recovery-confirmations", fmt.Sprintf(`{"token":%q}`, token), "", 400)
	t.Log("External SMTP accepted one guest recovery email and the scoped proof round trip passed. Inbox receipt confirmation remains required.")
}
