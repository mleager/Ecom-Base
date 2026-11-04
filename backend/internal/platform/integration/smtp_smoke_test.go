//go:build integration

package integration

import (
	"context"
	"os"
	"testing"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/email"
)

type smokeSender struct {
	sender   email.Sender
	captured captureSecurityMail
}

func (*smokeSender) Enabled() bool { return true }
func (s *smokeSender) Send(ctx context.Context, batch []email.Message) error {
	for i := range batch {
		batch[i].Body = "This is an explicitly requested, isolated Commerce Lab delivery test. Its link is consumed by the automated API round trip and cannot be used again. No action is required.\n\n" + batch[i].Body
	}
	if err := s.sender.Send(ctx, batch); err != nil {
		return err
	}
	return s.captured.Send(ctx, batch)
}

// Opt-in only: routine integration/browser runs never send external email.
func TestControlledMailboxSMTP(t *testing.T) {
	if os.Getenv("ECOM_SMTP_SMOKE") != "1" {
		t.Skip("requires explicit controlled-mailbox smoke opt-in")
	}
	recipient := os.Getenv("ECOM_MAIL_TEST_RECIPIENT")
	if recipient == "" {
		t.Fatal("controlled recipient is missing")
	}
	sender, err := email.New(email.Config{Mode: os.Getenv("MAIL_MODE"), Host: os.Getenv("SMTP_HOST"), Port: os.Getenv("SMTP_PORT"), TLSMode: os.Getenv("SMTP_TLS_MODE"), Username: os.Getenv("SMTP_USERNAME"), Password: os.Getenv("SMTP_PASSWORD"), From: os.Getenv("MAIL_FROM")})
	if err != nil || !sender.Enabled() {
		t.Fatal("private SMTP configuration is invalid or disabled")
	}
	f := newTestDatabase(t)
	capture := &smokeSender{sender: sender}
	service := verificationService(t, f, capture)
	user, err := service.Register(f.ctx, auth.Registration{FirstName: "Isolated", LastName: "Delivery Test", Email: recipient, Password: authTestPassword})
	if err != nil {
		t.Fatal("controlled mailbox registration failed")
	}
	tokens, err := service.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword})
	if err != nil {
		t.Fatal("controlled mailbox session failed")
	}
	sid := passwordSessionID(t, tokens.AccessToken)
	result := issueVerification(t, f, service, user, sid)
	if result.Delivery != "accepted" {
		t.Fatal("external SMTP acceptance was not confirmed; a message may still arrive, do not automatically retry")
	}
	raw := capture.captured.token(t)
	api := securityAPI(t, service)
	response := api.request(t, "POST", "/api/v1/users/me/email-verification/confirm", verificationJSON(auth.VerificationConfirmation{Token: raw, CurrentPassword: authTestPassword}), tokens.AccessToken, nil, true, 200)
	if len(response.cookies) != 0 {
		t.Fatal("verification changed session cookie")
	}
	profile, err := service.Authenticate(f.ctx, tokens.AccessToken)
	if err != nil || !profile.EmailVerified {
		t.Fatal("controlled delivery confirmation failed")
	}
	t.Log("External SMTP accepted one verification email; authenticated API link round trip passed. Human inbox receipt confirmation remains required. Isolated account/database removed on completion.")
}
