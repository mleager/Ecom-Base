//go:build integration

package integration

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/email"
	"github.com/jackc/pgx/v5/pgxpool"
)

func resetProof(t *testing.T, mail *captureSecurityMail) string {
	t.Helper()
	mail.mu.Lock()
	defer mail.mu.Unlock()
	for i := len(mail.messages) - 1; i >= 0; i-- {
		_, tail, ok := strings.Cut(mail.messages[i].Body, authTestOrigin+"/reset-password#token=")
		if ok {
			token, _, _ := strings.Cut(tail, "\n")
			if len(token) == 43 {
				return token
			}
		}
	}
	t.Fatal("owned recovery proof missing")
	return ""
}

func issueReset(t *testing.T, f *testDatabase, s *auth.Service, mail *captureSecurityMail, u auth.User) string {
	t.Helper()
	if s.RequestPasswordReset(f.ctx, auth.PasswordResetRequest{Email: "  " + strings.ToUpper(u.Email) + "  "}) != nil {
		t.Fatal("reset issuance failed")
	}
	return resetProof(t, mail)
}

func TestPasswordResetLifecycle(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	u, first, sid := changeAccount(t, f, s, "recovery")
	second, err := s.Login(f.ctx, auth.Credentials{Email: u.Email, Password: authTestPassword})
	if err != nil {
		t.Fatal("second session setup failed")
	}
	other, unrelated, _ := changeAccount(t, f, s, "unrelated")
	requestChange(t, f, s, u, sid, "proposed@example.test")
	before := mail.count()
	var tokens []string
	for range 3 {
		tokens = append(tokens, issueReset(t, f, s, mail, u))
	}
	restarted := verificationService(t, f, mail)
	if restarted.RequestPasswordReset(f.ctx, auth.PasswordResetRequest{Email: u.Email}) != nil || mail.count() != before+3 {
		t.Fatal("three-per-hour issuance limit failed")
	}
	for _, raw := range tokens {
		digest := sha256.Sum256([]byte(raw))
		var stored int
		if f.pool.QueryRow(f.ctx, `SELECT count(*) FROM account_security_tokens WHERE user_id=$1 AND purpose='reset_password' AND token_hash=$2 AND invalidated_at IS NULL AND consumed_at IS NULL AND expires_at-created_at BETWEEN interval '14 minutes 59 seconds' AND interval '15 minutes 1 second'`, u.ID, digest[:]).Scan(&stored) != nil || stored != 1 {
			t.Fatal("reset digest/lifetime or earlier-token preservation failed")
		}
	}
	if _, err := s.ConfirmPasswordReset(f.ctx, auth.PasswordResetConfirmation{Token: tokens[0], NewPassword: authTestPassword}); !errors.Is(err, auth.ErrInvalidInput) {
		t.Fatal("same password accepted")
	}
	api := securityAPI(t, s)
	body := verificationJSON(auth.PasswordResetConfirmation{Token: tokens[0], NewPassword: replacementPassword})
	response := api.request(t, "POST", "/api/v1/auth/password-resets/confirm", body, unrelated.AccessToken, &http.Cookie{Name: "ecom_refresh", Value: unrelated.Refresh}, true, 200)
	if len(response.cookies) != 0 || !strings.Contains(string(response.body), `"notification":"accepted"`) {
		t.Fatal("public reset changed caller cookies or omitted notification")
	}
	for _, access := range []string{first.AccessToken, second.AccessToken} {
		if _, err := s.Authenticate(f.ctx, access); !errors.Is(err, auth.ErrUnauthorized) {
			t.Fatal("reset left a target session active")
		}
	}
	if _, err := s.Authenticate(f.ctx, unrelated.AccessToken); err != nil {
		t.Fatal("reset revoked unrelated account")
	}
	if _, err := s.Login(f.ctx, auth.Credentials{Email: u.Email, Password: authTestPassword}); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatal("old password remained valid")
	}
	if _, err := s.Login(f.ctx, auth.Credentials{Email: u.Email, Password: replacementPassword}); err != nil {
		t.Fatal("replacement password rejected")
	}
	for _, raw := range tokens {
		if _, err := s.ConfirmPasswordReset(f.ctx, auth.PasswordResetConfirmation{Token: raw, NewPassword: "another replacement passphrase"}); !errors.Is(err, auth.ErrInvalidSecurityToken) {
			t.Fatal("reset token reused or sibling survived")
		}
	}
	var version int
	var pending, live int
	if f.pool.QueryRow(f.ctx, `SELECT credential_version FROM users WHERE id=$1`, u.ID).Scan(&version) != nil || version != 1 {
		t.Fatal("reset version update incorrect")
	}
	if f.pool.QueryRow(f.ctx, `SELECT count(*) FROM email_change_requests WHERE user_id=$1 AND state='pending'`, u.ID).Scan(&pending) != nil || pending != 0 {
		t.Fatal("reset retained pending email change")
	}
	if f.pool.QueryRow(f.ctx, `SELECT count(*) FROM account_security_tokens WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL`, u.ID).Scan(&live) != nil || live != 0 {
		t.Fatal("reset retained security proofs")
	}
	if _, err := s.Login(f.ctx, auth.Credentials{Email: other.Email, Password: authTestPassword}); err != nil {
		t.Fatal("unrelated credentials changed")
	}
}

func TestPasswordResetEligibilityAndHTTPParity(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	active, _, _ := changeAccount(t, f, s, "eligible")
	unverified, _, _ := verificationAccount(t, f, s, "unverified")
	inactive, _, _ := changeAccount(t, f, s, "inactive")
	if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET is_active=false WHERE id=$1`, inactive.ID); err != nil {
		t.Fatal("inactivity fixture failed")
	}
	api := securityAPI(t, s)
	path := "/api/v1/auth/password-resets"
	api.request(t, "POST", path, `{"email":"unknown@example.test"}`, "", nil, false, 403)
	for _, invalid := range []string{`{"email":null}`, `{"email":"bad"}`, `{"email":"unknown@example.test","token":"unexpected"}`} {
		want := 400
		if invalid == `{"email":"bad"}` {
			want = 422
		}
		api.request(t, "POST", path, invalid, "", nil, true, want)
	}
	for _, address := range []string{active.Email, unverified.Email, inactive.Email, "unknown@example.test", active.Email, active.Email, active.Email} {
		started := time.Now()
		result := api.request(t, "POST", path, verificationJSON(auth.PasswordResetRequest{Email: address}), "", nil, true, 202)
		if time.Since(started) < 5*time.Second || time.Since(started) > 6*time.Second || string(result.body) != "{\"message\":\""+auth.PasswordResetRequestMessage+"\"}\n" || len(result.cookies) != 0 {
			t.Fatal("eligibility/suppression changed response, timing or cookies")
		}
	}
	if mail.count() != 3 {
		t.Fatal("ineligible or suppressed address received mail")
	}
	failing, _, _ := changeAccount(t, f, s, "deliveryfailure")
	mail.fail.Store(true)
	started := time.Now()
	result := api.request(t, "POST", path, verificationJSON(auth.PasswordResetRequest{Email: failing.Email}), "", nil, true, 202)
	mail.fail.Store(false)
	if time.Since(started) < 5*time.Second || !strings.Contains(string(result.body), auth.PasswordResetRequestMessage) {
		t.Fatal("delivery failure disclosed eligibility")
	}
	closed, err := pgxpool.NewWithConfig(f.ctx, f.pool.Config())
	if err != nil {
		t.Fatal("lookup failure setup failed")
	}
	closed.Close()
	failedService, err := auth.NewService(closed, []byte(strings.Repeat("security-test-key", 2)), time.Now, auth.SecurityOptions{Sender: mail, Origin: authTestOrigin})
	if err != nil {
		t.Fatal("lookup failure service failed")
	}
	started = time.Now()
	result = securityAPI(t, failedService).request(t, "POST", path, verificationJSON(auth.PasswordResetRequest{Email: active.Email}), "", nil, true, 202)
	if time.Since(started) < 5*time.Second || !strings.Contains(string(result.body), auth.PasswordResetRequestMessage) {
		t.Fatal("lookup failure disclosed eligibility")
	}
	confirm := "/api/v1/auth/password-resets/confirm"
	api.request(t, "GET", confirm, "", "", nil, false, 405)
	api.request(t, "POST", confirm, `{"token":"bad","new_password":"a replacement passphrase"}`, "", nil, false, 403)
	for range 5 {
		api.request(t, "POST", confirm, `{"token":"bad","new_password":"a replacement passphrase"}`, "", nil, true, 400)
	}
	api.request(t, "POST", confirm, `{"token":"bad","new_password":"a replacement passphrase"}`, "", nil, true, 429)
	disabled := verificationService(t, f, email.Disabled{})
	for _, address := range []string{active.Email, "unknown@example.test"} {
		securityAPI(t, disabled).request(t, "POST", path, verificationJSON(auth.PasswordResetRequest{Email: address}), "", nil, true, 503)
	}
}

func TestPasswordResetRechecksAfterUserLock(t *testing.T) {
	for _, mutation := range []string{"expire", "credentials"} {
		t.Run(mutation, func(t *testing.T) {
			f := newTestDatabase(t)
			mail := &captureSecurityMail{}
			s := verificationService(t, f, mail)
			u, _, _ := changeAccount(t, f, s, "waiting")
			raw := issueReset(t, f, s, mail, u)
			tx, err := f.migrator.Begin(f.ctx)
			if err != nil {
				t.Fatal("lock transaction failed")
			}
			defer tx.Rollback(f.ctx)
			if _, err = tx.Exec(f.ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, u.ID); err != nil {
				t.Fatal("user lock fixture failed")
			}
			done := make(chan error, 1)
			go func() {
				_, err := s.ConfirmPasswordReset(f.ctx, auth.PasswordResetConfirmation{Token: raw, NewPassword: replacementPassword})
				done <- err
			}()
			deadline := time.Now().Add(time.Second)
			waiting := false
			for !waiting && time.Now().Before(deadline) {
				if f.pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%name: LockUser :one%' AND wait_event_type='Lock')`).Scan(&waiting) != nil {
					t.Fatal("lock observation failed")
				}
				if !waiting {
					time.Sleep(5 * time.Millisecond)
				}
			}
			if !waiting {
				t.Fatal("redemption did not reach the lock barrier")
			}
			if mutation == "expire" {
				_, err = tx.Exec(f.ctx, `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1`, u.ID)
			} else {
				_, err = tx.Exec(f.ctx, `UPDATE users SET credential_version=credential_version+1 WHERE id=$1`, u.ID)
			}
			if err != nil || tx.Commit(f.ctx) != nil {
				t.Fatal("barrier mutation failed")
			}
			if err := <-done; !errors.Is(err, auth.ErrInvalidSecurityToken) {
				t.Fatal("redemption trusted a stale pre-lock snapshot")
			}
			var consumed bool
			if f.pool.QueryRow(f.ctx, `SELECT consumed_at IS NOT NULL FROM account_security_tokens WHERE user_id=$1`, u.ID).Scan(&consumed) != nil || consumed {
				t.Fatal("stale reset consumed proof")
			}
		})
	}
}

func TestPasswordResetCredentialAndSessionRaces(t *testing.T) {
	for round := range 3 {
		t.Run(fmt.Sprint(round), func(t *testing.T) {
			f := newTestDatabase(t)
			mail := &captureSecurityMail{}
			s := verificationService(t, f, mail)
			u, initial, sid := changeAccount(t, f, s, "securityrace")
			raw := issueReset(t, f, s, mail, u)
			passwordService := verificationService(t, f, mail)
			loginService := verificationService(t, f, mail)
			start := make(chan struct{})
			results := make(chan error, 4)
			go func() {
				<-start
				_, err := s.ConfirmPasswordReset(f.ctx, auth.PasswordResetConfirmation{Token: raw, NewPassword: replacementPassword})
				results <- err
			}()
			go func() {
				<-start
				_, err := passwordService.ChangePassword(f.ctx, u.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword})
				results <- err
			}()
			go func() {
				<-start
				_, err := loginService.Login(f.ctx, auth.Credentials{Email: u.Email, Password: authTestPassword})
				results <- err
			}()
			go func() { <-start; _, err := s.Refresh(f.ctx, initial.Refresh); results <- err }()
			close(start)
			for range 4 {
				err := <-results
				if err != nil && !errors.Is(err, auth.ErrUnauthorized) && !errors.Is(err, auth.ErrInvalidSecurityToken) && !errors.Is(err, auth.ErrCredentialsChanged) && !errors.Is(err, auth.ErrReauthentication) {
					t.Fatal("unexpected credential/session race failure")
				}
			}
			var version, live int
			if f.pool.QueryRow(f.ctx, `SELECT credential_version FROM users WHERE id=$1`, u.ID).Scan(&version) != nil || version != 1 {
				t.Fatal("credential race applied multiple updates")
			}
			if f.pool.QueryRow(f.ctx, `SELECT count(*) FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL`, u.ID).Scan(&live) != nil || live != 0 {
				t.Fatal("old-credential login or refresh escaped reset revocation")
			}
			if _, err := s.Login(f.ctx, auth.Credentials{Email: u.Email, Password: replacementPassword}); err != nil {
				t.Fatal("raced replacement password invalid")
			}
		})
	}
}

func TestPasswordResetEmailChangeRace(t *testing.T) {
	for round := range 2 {
		t.Run(fmt.Sprint(round), func(t *testing.T) {
			f := newTestDatabase(t)
			mail := &captureSecurityMail{}
			s := verificationService(t, f, mail)
			u, initial, sid := changeAccount(t, f, s, "emailresetrace")
			target := "changed@example.test"
			requestChange(t, f, s, u, sid, target)
			proofs := changeProofs(t, mail, u.Email, target)
			if _, err := confirmChange(s, f, u, sid, proofs[0]); err != nil {
				t.Fatal("partial email proof failed")
			}
			raw := issueReset(t, f, s, mail, u)
			start := make(chan struct{})
			results := make(chan error, 2)
			go func() {
				<-start
				_, err := s.ConfirmPasswordReset(f.ctx, auth.PasswordResetConfirmation{Token: raw, NewPassword: replacementPassword})
				results <- err
			}()
			go func() { <-start; _, err := confirmChange(s, f, u, sid, proofs[1]); results <- err }()
			close(start)
			winners := 0
			for range 2 {
				err := <-results
				if err == nil {
					winners++
				} else if !errors.Is(err, auth.ErrInvalidSecurityToken) && !errors.Is(err, auth.ErrUnauthorized) && !errors.Is(err, auth.ErrCredentialsChanged) && !errors.Is(err, auth.ErrReauthentication) {
					t.Fatal("unexpected reset/email race failure")
				}
			}
			if winners != 1 {
				t.Fatal("reset and email change both committed or both failed")
			}
			var version int
			var address string
			if f.pool.QueryRow(f.ctx, `SELECT credential_version,email FROM users WHERE id=$1`, u.ID).Scan(&version, &address) != nil || version != 1 {
				t.Fatal("reset/email race version incorrect")
			}
			password := replacementPassword
			if address == target {
				password = authTestPassword
			} else if address != u.Email {
				t.Fatal("reset/email race selected unknown email")
			}
			if _, err := s.Authenticate(f.ctx, initial.AccessToken); !errors.Is(err, auth.ErrUnauthorized) {
				t.Fatal("reset/email race retained old session")
			}
			if _, err := s.Login(f.ctx, auth.Credentials{Email: address, Password: password}); err != nil {
				t.Fatal("winning reset/email credentials invalid")
			}
		})
	}
}

func TestPasswordResetBindingAndRollback(t *testing.T) {
	for _, scenario := range []string{"expired", "inactive", "unverified", "email", "version", "purpose", "overflow", "rollback", "notification"} {
		t.Run(scenario, func(t *testing.T) {
			f := newTestDatabase(t)
			mail := &captureSecurityMail{}
			s := verificationService(t, f, mail)
			u, first, _ := changeAccount(t, f, s, "binding")
			raw := issueReset(t, f, s, mail, u)
			var query string
			switch scenario {
			case "expired":
				query = `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1`
			case "inactive":
				query = `UPDATE users SET is_active=false WHERE id=$1`
			case "unverified":
				query = `UPDATE users SET email_verified_at=NULL WHERE id=$1`
			case "email":
				query = `UPDATE users SET email='different@example.test' WHERE id=$1`
			case "version":
				query = `UPDATE users SET credential_version=credential_version+1 WHERE id=$1`
			case "purpose":
				query = `UPDATE account_security_tokens SET purpose='verify_email' WHERE user_id=$1`
			case "overflow":
				query = `WITH u AS (UPDATE users SET credential_version=9223372036854775807 WHERE id=$1 RETURNING id) UPDATE account_security_tokens SET credential_version=9223372036854775807 WHERE user_id IN (SELECT id FROM u)`
			case "rollback":
				query = `CREATE FUNCTION public.reject_reset() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''controlled reset failure''; END'; CREATE TRIGGER reject_reset BEFORE UPDATE OF password_hash ON users FOR EACH ROW EXECUTE FUNCTION public.reject_reset()`
			case "notification":
				mail.fail.Store(true)
			default:
				t.Fatal("unhandled reset fixture")
			}
			if query != "" {
				var err error
				if scenario == "rollback" {
					_, err = f.migrator.Exec(f.ctx, query)
				} else {
					_, err = f.migrator.Exec(f.ctx, query, u.ID)
				}
				if err != nil {
					t.Fatal("owned binding fixture failed")
				}
			}
			result, err := s.ConfirmPasswordReset(f.ctx, auth.PasswordResetConfirmation{Token: raw, NewPassword: replacementPassword})
			switch scenario {
			case "notification":
				if err != nil || result.Notification != "unconfirmed" {
					t.Fatal("notification failure changed committed reset")
				}
			case "overflow":
				if !errors.Is(err, auth.ErrCredentialVersion) {
					t.Fatal("credential overflow not guarded")
				}
			case "rollback":
				if !errors.Is(err, auth.ErrSecurityUnavailable) {
					t.Fatal("reset failure not reported")
				}
				var consumed bool
				if f.pool.QueryRow(f.ctx, `SELECT consumed_at IS NOT NULL FROM account_security_tokens WHERE user_id=$1`, u.ID).Scan(&consumed) != nil || consumed {
					t.Fatal("failed mutation consumed token")
				}
				if _, err := s.Authenticate(f.ctx, first.AccessToken); err != nil {
					t.Fatal("failed reset revoked session")
				}
			case "expired", "inactive", "unverified", "email", "version", "purpose":
				if !errors.Is(err, auth.ErrInvalidSecurityToken) {
					t.Fatal("unbound or expired recovery proof accepted")
				}
			default:
				t.Fatal("unhandled reset expectation")
			}
		})
	}
}

func TestPasswordResetConcurrentAndDeadline(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	u, _, _ := changeAccount(t, f, s, "concurrent")
	var wg sync.WaitGroup
	failures := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			failures <- s.RequestPasswordReset(f.ctx, auth.PasswordResetRequest{Email: u.Email})
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal("concurrent issuance failed")
		}
	}
	if mail.count() != 3 {
		t.Fatal("concurrent issuance exceeded persistent budget")
	}
	raw := resetProof(t, mail)
	results := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := s.ConfirmPasswordReset(f.ctx, auth.PasswordResetConfirmation{Token: raw, NewPassword: replacementPassword})
			results <- err
		}()
	}
	winners := 0
	for range 2 {
		err := <-results
		if err == nil {
			winners++
		} else if !errors.Is(err, auth.ErrInvalidSecurityToken) {
			t.Fatal("unexpected concurrent reset result")
		}
	}
	if winners != 1 {
		t.Fatal("reset was not single use under concurrency")
	}
	other, _, _ := changeAccount(t, f, s, "locked")
	tx, err := f.migrator.Begin(f.ctx)
	if err != nil {
		t.Fatal("lock setup failed")
	}
	defer tx.Rollback(f.ctx)
	if _, err = tx.Exec(f.ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, other.ID); err != nil {
		t.Fatal("lock fixture failed")
	}
	ctx, cancel := context.WithTimeout(f.ctx, 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err = s.RequestPasswordReset(ctx, auth.PasswordResetRequest{Email: other.Email}); err == nil || time.Since(started) > time.Second {
		t.Fatal("issuance ignored work cancellation")
	}
	if tx.Rollback(f.ctx) != nil {
		t.Fatal("lock release failed")
	}
	if s.RequestPasswordReset(f.ctx, auth.PasswordResetRequest{Email: other.Email}) != nil {
		t.Fatal("cancelled issuance left a live lock/transaction")
	}
}

func TestPasswordResetLostCommit(t *testing.T) {
	for _, action := range []string{"request", "confirm"} {
		for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter} {
			t.Run(fmt.Sprintf("%s/%d", action, mode), func(t *testing.T) {
				f := newTestDatabase(t)
				mail := &captureSecurityMail{}
				s := verificationService(t, f, mail)
				u, _, _ := changeAccount(t, f, s, "commitreset")
				var raw string
				if action == "confirm" {
					raw = issueReset(t, f, s, mail, u)
				}
				before := mail.count()
				pool, fault := newCommitFaultPool(t, f, mode)
				faulty, err := auth.NewService(pool, []byte(strings.Repeat("security-test-key", 2)), time.Now, auth.SecurityOptions{Sender: mail, Origin: authTestOrigin})
				if err != nil {
					t.Fatal("fault setup failed")
				}
				if action == "request" {
					err = faulty.RequestPasswordReset(f.ctx, auth.PasswordResetRequest{Email: u.Email})
				} else {
					_, err = faulty.ConfirmPasswordReset(f.ctx, auth.PasswordResetConfirmation{Token: raw, NewPassword: replacementPassword})
				}
				if !errors.Is(err, auth.ErrSecurityOutcomeUnknown) {
					t.Fatal("unknown reset commit reported a definitive outcome")
				}
				awaitCommitFault(t, fault)
				if mail.count() != before {
					t.Fatal("unknown reset commit sent mail")
				}
				var version, count int
				if f.pool.QueryRow(f.ctx, `SELECT credential_version FROM users WHERE id=$1`, u.ID).Scan(&version) != nil || f.pool.QueryRow(f.ctx, `SELECT count(*) FROM account_security_tokens WHERE user_id=$1`, u.ID).Scan(&count) != nil {
					t.Fatal("commit readback failed")
				}
				wantVersion, wantCount := 0, 1
				if action == "confirm" && mode == commitDropAfter {
					wantVersion = 1
				}
				if action == "request" && mode == commitDropBefore {
					wantCount = 0
				}
				if version != wantVersion || count != wantCount {
					t.Fatal("reset commit was lost or repeated")
				}
			})
		}
	}
}
