//go:build integration

package integration

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/email"
)

type captureSecurityMail struct {
	mu       sync.Mutex
	messages []email.Message
	fail     atomic.Bool
}

func (*captureSecurityMail) Enabled() bool { return true }
func (s *captureSecurityMail) Send(_ context.Context, messages []email.Message) error {
	s.mu.Lock()
	s.messages = append(s.messages, messages...)
	s.mu.Unlock()
	if s.fail.Load() {
		return email.ErrDelivery
	}
	return nil
}
func (s *captureSecurityMail) token(t *testing.T) string {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.messages) == 0 {
		t.Fatal("verification mail missing")
	}
	body := s.messages[len(s.messages)-1].Body
	_, tail, ok := strings.Cut(body, authTestOrigin+"/verify-email#token=")
	if !ok {
		t.Fatal("verification link origin/fragment invalid")
	}
	token, _, _ := strings.Cut(tail, "\n")
	if len(token) != 43 {
		t.Fatal("verification token encoding invalid")
	}
	return token
}
func (s *captureSecurityMail) count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.messages) }
func verificationService(t *testing.T, f *testDatabase, sender email.Sender) *auth.Service {
	t.Helper()
	s, err := auth.NewService(f.pool, []byte(strings.Repeat("security-test-key", 2)), time.Now, auth.SecurityOptions{Sender: sender, Origin: authTestOrigin})
	if err != nil {
		t.Fatal("verification service failed")
	}
	return s
}
func verificationAccount(t *testing.T, f *testDatabase, s *auth.Service, name string) (auth.User, auth.Tokens, string) {
	t.Helper()
	user, err := s.Register(f.ctx, auth.Registration{FirstName: "Email", LastName: "Test", Email: name + "@example.test", Password: authTestPassword})
	if err != nil {
		t.Fatal("registration failed")
	}
	tokens, err := s.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword})
	if err != nil {
		t.Fatal("login failed")
	}
	return user, tokens, passwordSessionID(t, tokens.AccessToken)
}
func verificationJSON(value any) string { body, _ := json.Marshal(value); return string(body) }
func issueVerification(t *testing.T, f *testDatabase, s *auth.Service, user auth.User, sid string) auth.MailRequestResult {
	t.Helper()
	result, err := s.RequestVerification(f.ctx, user.ID, sid, auth.VerificationRequest{CurrentPassword: authTestPassword})
	if err != nil {
		t.Fatal("verification issuance failed")
	}
	return result
}

func TestEmailVerificationLifecycle(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	user, tokens, sid := verificationAccount(t, f, s, "verification")
	if user.EmailVerified || mail.count() != 0 {
		t.Fatal("registration trusted an email or sent unsolicited mail")
	}
	status, err := s.SecurityStatus(f.ctx, user.ID)
	if err != nil || !status.EmailDeliveryAvailable || status.PendingEmailChange != nil {
		t.Fatal("security status invalid")
	}
	api := securityAPI(t, s)
	path := "/api/v1/users/me/email-verification"
	body := verificationJSON(auth.VerificationRequest{CurrentPassword: authTestPassword})
	api.request(t, "POST", path, body, "", nil, true, 401)
	api.request(t, "POST", path, body, tokens.AccessToken, nil, false, 403)
	api.request(t, "POST", path, `{"current_password":null}`, tokens.AccessToken, nil, true, 400)
	api.request(t, "POST", path, `{"current_password":"a long enough password","email":"other@example.test"}`, tokens.AccessToken, nil, true, 400)
	api.request(t, "POST", path, verificationJSON(auth.VerificationRequest{CurrentPassword: "wrong current password"}), tokens.AccessToken, nil, true, 403)
	response := securityAPI(t, s).request(t, "POST", path, body, tokens.AccessToken, nil, true, 202)
	if !strings.Contains(string(response.body), `"delivery":"accepted"`) {
		t.Fatal("missing explicit delivery result")
	}
	raw := mail.token(t)
	hash := sha256.Sum256([]byte(raw))
	var stored []byte
	var verified bool
	if err := f.pool.QueryRow(f.ctx, `SELECT token_hash FROM account_security_tokens WHERE user_id=$1`, user.ID).Scan(&stored); err != nil || string(stored) != string(hash[:]) || strings.Contains(string(response.body), raw) {
		t.Fatal("token digest/storage or response secrecy failed")
	}
	if _, err := s.RequestVerification(f.ctx, user.ID, sid, auth.VerificationRequest{CurrentPassword: authTestPassword}); err == nil {
		t.Fatal("cooldown missing")
	}
	foreign, _, foreignSID := verificationAccount(t, f, s, "foreign")
	if _, err := s.ConfirmVerification(f.ctx, foreign.ID, foreignSID, auth.VerificationConfirmation{Token: raw, CurrentPassword: authTestPassword}); !errors.Is(err, auth.ErrInvalidSecurityToken) {
		t.Fatal("foreign account accepted token")
	}
	if _, err := s.ConfirmVerification(f.ctx, user.ID, sid, auth.VerificationConfirmation{Token: raw, CurrentPassword: "wrong current password"}); !errors.Is(err, auth.ErrReauthentication) {
		t.Fatal("confirmation skipped password proof")
	}
	// A scanner opening the browser URL cannot consume a database token.
	securityAPI(t, s).request(t, "GET", path+"/confirm", "", tokens.AccessToken, nil, false, 405)
	if err := f.pool.QueryRow(f.ctx, `SELECT email_verified_at IS NOT NULL FROM users WHERE id=$1`, user.ID).Scan(&verified); err != nil || verified {
		t.Fatal("GET or failed proof verified email")
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.ConfirmVerification(f.ctx, user.ID, sid, auth.VerificationConfirmation{Token: raw, CurrentPassword: authTestPassword})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	winners := 0
	for err := range results {
		if err == nil {
			winners++
		} else if !errors.Is(err, auth.ErrInvalidSecurityToken) {
			t.Fatal("unexpected confirmation race error")
		}
	}
	if winners != 1 {
		t.Fatal("token did not have exactly one winner")
	}
	principal, err := s.Authenticate(f.ctx, tokens.AccessToken)
	if err != nil || !principal.EmailVerified {
		t.Fatal("verification revoked session or profile was stale")
	}
	if _, err := s.Refresh(f.ctx, tokens.Refresh); err != nil {
		t.Fatal("verification invalidated refresh session")
	}
	if result := issueVerification(t, f, s, user, sid); result.Delivery != "not_required" || mail.count() != 1 {
		t.Fatal("verified account was mailed again")
	}
	if _, err := s.ChangePassword(f.ctx, user.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword}); err != nil || mail.count() != 2 {
		t.Fatal("verified password change notification failed")
	}
}

func TestEmailVerificationInvalidationAndBounds(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	for i, kind := range []string{"resend", "expired", "purpose", "version", "email", "password", "revoked", "inactive", "rollback", "mail failure"} {
		t.Run(kind, func(t *testing.T) {
			user, tokens, sid := verificationAccount(t, f, s, fmt.Sprintf("binding%d", i))
			issueVerification(t, f, s, user, sid)
			old := mail.token(t)
			var statement string
			switch kind {
			case "resend":
				statement = `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '61 seconds' WHERE user_id=$1`
			case "expired":
				statement = `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1`
			case "purpose":
				statement = `UPDATE account_security_tokens SET purpose='reset_password' WHERE user_id=$1`
			case "version":
				statement = `UPDATE users SET credential_version=credential_version+1 WHERE id=$1`
			case "email":
				statement = `UPDATE users SET email='changed@example.test' WHERE id=$1`
			case "revoked":
				statement = `UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1`
			case "inactive":
				statement = `UPDATE users SET is_active=false WHERE id=$1`
			case "password":
				if _, err := s.ChangePassword(f.ctx, user.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword}); err != nil {
					t.Fatal("password mutation failed")
				}
			case "rollback":
				if _, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION fail_verification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled verification failure'; END $$; CREATE TRIGGER fail_verification BEFORE UPDATE OF email_verified_at ON users FOR EACH ROW EXECUTE FUNCTION fail_verification()`); err != nil {
					t.Fatal("trigger failed")
				}
			case "mail failure":
				mail.fail.Store(true)
				statement = `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '61 seconds' WHERE user_id=$1`
			default:
				t.Fatal("unhandled test case")
			}
			if statement != "" {
				if _, err := f.migrator.Exec(f.ctx, statement, user.ID); err != nil {
					t.Fatal("controlled binding mutation failed")
				}
			}
			if kind == "resend" || kind == "mail failure" {
				result := issueVerification(t, f, s, user, sid)
				expected := "accepted"
				if kind == "mail failure" {
					expected = "unconfirmed"
				}
				mail.fail.Store(false)
				if result.Delivery != expected {
					t.Fatal("incorrect delivery classification")
				}
			}
			_, err := s.ConfirmVerification(f.ctx, user.ID, sid, auth.VerificationConfirmation{Token: old, CurrentPassword: authTestPassword})
			if err == nil {
				t.Fatal("invalidated proof accepted")
			}
			if kind == "rollback" {
				if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER fail_verification ON users; DROP FUNCTION fail_verification()`); err != nil {
					t.Fatal("trigger cleanup failed")
				}
				if _, err := s.ConfirmVerification(f.ctx, user.ID, sid, auth.VerificationConfirmation{Token: old, CurrentPassword: authTestPassword}); err != nil {
					t.Fatal("rollback consumed token")
				}
			}
			if kind == "password" {
				if _, err := s.Authenticate(f.ctx, tokens.AccessToken); !errors.Is(err, auth.ErrUnauthorized) {
					t.Fatal("password change left session valid")
				}
			}
		})
	}
	user, _, sid := verificationAccount(t, f, s, "budget")
	for range 5 {
		issueVerification(t, f, s, user, sid)
		if _, err := f.migrator.Exec(f.ctx, `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '61 seconds' WHERE user_id=$1`, user.ID); err != nil {
			t.Fatal("budget time setup failed")
		}
	}
	_, err := s.RequestVerification(f.ctx, user.ID, sid, auth.VerificationRequest{CurrentPassword: authTestPassword})
	var limit *auth.SecurityMailLimitError
	if !errors.As(err, &limit) || limit.Seconds != 3600 {
		t.Fatal("persistent hourly budget missing")
	}
	disabled := verificationService(t, f, email.Disabled{})
	newUser, _, newSID := verificationAccount(t, f, s, "disabled")
	if _, err := disabled.RequestVerification(f.ctx, newUser.ID, newSID, auth.VerificationRequest{CurrentPassword: authTestPassword}); !errors.Is(err, auth.ErrMailDisabled) {
		t.Fatal("disabled delivery issued proof")
	}
	for _, table := range []string{"account_security_tokens", "email_change_requests"} {
		var allowed bool
		if err := f.pool.QueryRow(f.ctx, `SELECT has_table_privilege(current_user,$1,'DELETE')`, table).Scan(&allowed); err != nil || allowed {
			t.Fatal("runtime may prune security history")
		}
	}
}

func TestEmailVerificationCommitUncertainty(t *testing.T) {
	for _, confirm := range []bool{false, true} {
		for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter} {
			t.Run(fmt.Sprintf("confirm=%t/mode=%d", confirm, mode), func(t *testing.T) {
				f := newTestDatabase(t)
				mail := &captureSecurityMail{}
				s := verificationService(t, f, mail)
				user, _, sid := verificationAccount(t, f, s, "commitmail")
				raw := ""
				if confirm {
					issueVerification(t, f, s, user, sid)
					raw = mail.token(t)
				}
				pool, fault := newCommitFaultPool(t, f, mode)
				faulty, err := auth.NewService(pool, []byte(strings.Repeat("security-test-key", 2)), time.Now, auth.SecurityOptions{Sender: mail, Origin: authTestOrigin})
				if err != nil {
					t.Fatal("faulty service setup failed")
				}
				if confirm {
					_, err = faulty.ConfirmVerification(f.ctx, user.ID, sid, auth.VerificationConfirmation{Token: raw, CurrentPassword: authTestPassword})
				} else {
					_, err = faulty.RequestVerification(f.ctx, user.ID, sid, auth.VerificationRequest{CurrentPassword: authTestPassword})
				}
				if !errors.Is(err, auth.ErrSecurityOutcomeUnknown) {
					t.Fatal("unknown COMMIT reported definitive outcome")
				}
				awaitCommitFault(t, fault)
				var verified bool
				var count int
				if err := f.pool.QueryRow(f.ctx, `SELECT email_verified_at IS NOT NULL FROM users WHERE id=$1`, user.ID).Scan(&verified); err != nil {
					t.Fatal("verification reconciliation failed")
				}
				if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM account_security_tokens WHERE user_id=$1`, user.ID).Scan(&count); err != nil {
					t.Fatal("issuance reconciliation failed")
				}
				if confirm {
					if verified != (mode == commitDropAfter) {
						t.Fatal("verification outcome mismatch")
					}
				} else {
					expected := 0
					if mode == commitDropAfter {
						expected = 1
					}
					if count != expected || mail.count() != 0 {
						t.Fatal("unknown issuance sent mail or replayed transaction")
					}
				}
			})
		}
	}
}

func TestAccountSecurityStatusIsolation(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	user, _, sid := verificationAccount(t, f, s, "pendingowner")
	foreign, _, _ := verificationAccount(t, f, s, "pendingforeign")
	_, err := f.migrator.Exec(f.ctx, `INSERT INTO email_change_requests(id,user_id,old_email,new_email,credential_version,expires_at) VALUES('11111111-1111-4111-8111-111111111111',$1,$2,'replacement@example.test',0,clock_timestamp()+interval '30 minutes')`, user.ID, user.Email)
	if err != nil {
		t.Fatal("pending fixture insertion failed")
	}
	owned, err := s.SecurityStatus(f.ctx, user.ID)
	if err != nil || owned.PendingEmailChange == nil || owned.PendingEmailChange.NewEmail != "replacement@example.test" || owned.PendingEmailChange.OldConfirmed || owned.PendingEmailChange.NewConfirmed {
		t.Fatal("owned pending status invalid")
	}
	other, err := s.SecurityStatus(f.ctx, foreign.ID)
	if err != nil || other.PendingEmailChange != nil {
		t.Fatal("foreign pending state leaked")
	}
	if _, err := f.migrator.Exec(f.ctx, `UPDATE email_change_requests SET created_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1`, user.ID); err != nil {
		t.Fatal("pending expiry setup failed")
	}
	status, err := s.SecurityStatus(f.ctx, user.ID)
	if err != nil || status.PendingEmailChange != nil {
		t.Fatal("expired pending state exposed")
	}
	issueVerification(t, f, s, user, sid)
	if _, err := s.ChangePassword(f.ctx, user.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword}); err != nil {
		t.Fatal("password change failed")
	}
	var cancelled, invalidated bool
	if err := f.pool.QueryRow(f.ctx, `SELECT state='cancelled' AND finished_at IS NOT NULL FROM email_change_requests WHERE user_id=$1`, user.ID).Scan(&cancelled); err != nil || !cancelled {
		t.Fatal("password change did not cancel pending request")
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT invalidated_at IS NOT NULL FROM account_security_tokens WHERE user_id=$1`, user.ID).Scan(&invalidated); err != nil || !invalidated {
		t.Fatal("password change did not invalidate proof")
	}
}

func TestEmailVerificationPasswordRace(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	for i := range 3 {
		user, tokens, sid := verificationAccount(t, f, s, fmt.Sprintf("proofrace%d", i))
		issueVerification(t, f, s, user, sid)
		token := mail.token(t)
		start := make(chan struct{})
		confirmation := make(chan error, 1)
		password := make(chan error, 1)
		go func() {
			<-start
			_, err := s.ConfirmVerification(f.ctx, user.ID, sid, auth.VerificationConfirmation{Token: token, CurrentPassword: authTestPassword})
			confirmation <- err
		}()
		go func() {
			<-start
			_, err := s.ChangePassword(f.ctx, user.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword})
			password <- err
		}()
		close(start)
		if err := <-password; err != nil {
			t.Fatal("verification blocked password change")
		}
		err := <-confirmation
		if err != nil && !errors.Is(err, auth.ErrUnauthorized) && !errors.Is(err, auth.ErrCredentialsChanged) && !errors.Is(err, auth.ErrReauthentication) && !errors.Is(err, auth.ErrInvalidSecurityToken) {
			t.Fatal("unexpected proof/password race error")
		}
		if _, err := s.Authenticate(f.ctx, tokens.AccessToken); !errors.Is(err, auth.ErrUnauthorized) {
			t.Fatal("raced session survived password change")
		}
		var terminal bool
		if err := f.pool.QueryRow(f.ctx, `SELECT (consumed_at IS NOT NULL) <> (invalidated_at IS NOT NULL) FROM account_security_tokens WHERE user_id=$1`, user.ID).Scan(&terminal); err != nil || !terminal {
			t.Fatal("proof was neither consumed nor invalidated exactly once")
		}
	}
}
