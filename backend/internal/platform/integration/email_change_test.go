//go:build integration

package integration

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/email"
)

func changeAccount(t *testing.T, f *testDatabase, s *auth.Service, name string) (auth.User, auth.Tokens, string) {
	t.Helper()
	user, tokens, sid := verificationAccount(t, f, s, name)
	if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1`, user.ID); err != nil {
		t.Fatal("owned verification fixture failed")
	}
	return user, tokens, sid
}
func changeProofs(t *testing.T, mail *captureSecurityMail, oldEmail, newEmail string) [2]string {
	t.Helper()
	mail.mu.Lock()
	defer mail.mu.Unlock()
	var result [2]string
	for _, m := range mail.messages {
		for i, target := range []string{oldEmail, newEmail} {
			if m.To != target {
				continue
			}
			_, tail, ok := strings.Cut(m.Body, authTestOrigin+"/confirm-email-change#token=")
			if ok {
				result[i], _, _ = strings.Cut(tail, "\n")
			}
		}
	}
	if len(result[0]) != 43 || len(result[1]) != 43 || result[0] == result[1] {
		t.Fatal("independent bound mailbox proofs missing")
	}
	return result
}
func requestChange(t *testing.T, f *testDatabase, s *auth.Service, u auth.User, sid, target string) {
	t.Helper()
	result, err := s.RequestEmailChange(f.ctx, u.ID, sid, auth.EmailChangeRequest{NewEmail: target, CurrentPassword: authTestPassword})
	if err != nil || result.Delivery != "accepted" {
		t.Fatal("email change issuance failed")
	}
}
func confirmChange(s *auth.Service, f *testDatabase, u auth.User, sid, token string) (auth.EmailChangeResult, error) {
	return s.ConfirmEmailChange(f.ctx, u.ID, sid, auth.VerificationConfirmation{Token: token, CurrentPassword: authTestPassword})
}
func allowChangeResend(t *testing.T, f *testDatabase, userID string) {
	t.Helper()
	if _, err := f.migrator.Exec(f.ctx, `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '61 seconds' WHERE user_id=$1 AND purpose='email_change_old'`, userID); err != nil {
		t.Fatal("owned issuance clock adjustment failed")
	}
}

func TestVerifiedEmailChange(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	for _, order := range [][2]int{{0, 1}, {1, 0}} {
		t.Run(fmt.Sprint(order), func(t *testing.T) {
			user, first, sid := changeAccount(t, f, s, fmt.Sprintf("complete%d", order[0]))
			next := fmt.Sprintf("next%d@example.test", order[0])
			second, err := s.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword})
			if err != nil {
				t.Fatal("second session failed")
			}
			var cartBefore string
			if f.pool.QueryRow(f.ctx, `SELECT id::text FROM carts WHERE user_id=$1`, user.ID).Scan(&cartBefore) != nil {
				t.Fatal("cart missing")
			}
			api := securityAPI(t, s)
			body := verificationJSON(auth.EmailChangeRequest{NewEmail: "  " + strings.ToUpper(next) + "  ", CurrentPassword: authTestPassword})
			response := api.request(t, "POST", "/api/v1/users/me/email-change", body, first.AccessToken, nil, true, 202)
			proofs := changeProofs(t, mail, user.Email, next)
			for _, raw := range proofs {
				hash := sha256.Sum256([]byte(raw))
				var count int
				if f.pool.QueryRow(f.ctx, `SELECT count(*) FROM account_security_tokens WHERE user_id=$1 AND token_hash=$2`, user.ID, hash[:]).Scan(&count) != nil || count != 1 || strings.Contains(string(response.body), raw) {
					t.Fatal("proof digest/response secrecy failed")
				}
			}
			status, err := s.SecurityStatus(f.ctx, user.ID)
			if err != nil || status.PendingEmailChange == nil || status.PendingEmailChange.NewEmail != next {
				t.Fatal("pending status missing")
			}
			expiry := status.PendingEmailChange.ExpiresAt
			firstResult, err := confirmChange(s, f, user, sid, proofs[order[0]])
			if err != nil || !firstResult.Pending {
				t.Fatal("first proof changed credentials")
			}
			if _, err := s.Authenticate(f.ctx, first.AccessToken); err != nil {
				t.Fatal("first proof revoked session")
			}
			status, err = s.SecurityStatus(f.ctx, user.ID)
			if err != nil || status.PendingEmailChange == nil || !status.PendingEmailChange.ExpiresAt.Equal(expiry) || status.PendingEmailChange.OldConfirmed != (order[0] == 0) || status.PendingEmailChange.NewConfirmed != (order[0] == 1) {
				t.Fatal("partial state/expiry incorrect")
			}
			if _, err := confirmChange(s, f, user, sid, proofs[order[0]]); !errors.Is(err, auth.ErrInvalidSecurityToken) {
				t.Fatal("first proof reused")
			}
			if _, err := s.Login(f.ctx, auth.Credentials{Email: next, Password: authTestPassword}); !errors.Is(err, auth.ErrUnauthorized) {
				t.Fatal("proposed address became active early")
			}
			response = securityAPI(t, s).request(t, "POST", "/api/v1/users/me/email-change/confirm", verificationJSON(auth.VerificationConfirmation{Token: proofs[order[1]], CurrentPassword: authTestPassword}), first.AccessToken, nil, true, 200)
			if len(response.cookies) != 1 || response.cookies[0].MaxAge != -1 || !strings.Contains(string(response.body), `"notification":"accepted"`) {
				t.Fatal("completion did not clear cookie/report notification")
			}
			for _, token := range []auth.Tokens{first, second} {
				if _, err := s.Authenticate(f.ctx, token.AccessToken); !errors.Is(err, auth.ErrUnauthorized) {
					t.Fatal("old JWT survived email change")
				}
				if _, err := s.Refresh(f.ctx, token.Refresh); !errors.Is(err, auth.ErrUnauthorized) {
					t.Fatal("old refresh survived email change")
				}
			}
			if _, err := s.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword}); !errors.Is(err, auth.ErrUnauthorized) {
				t.Fatal("old address still authenticates")
			}
			fresh, err := s.Login(f.ctx, auth.Credentials{Email: next, Password: authTestPassword})
			if err != nil {
				t.Fatal("new email login failed")
			}
			principal, err := s.Authenticate(f.ctx, fresh.AccessToken)
			if err != nil || principal.ID != user.ID || !principal.EmailVerified {
				t.Fatal("email change replaced account identity or lost trust")
			}
			var cartAfter string
			var version int64
			if f.pool.QueryRow(f.ctx, `SELECT id::text FROM carts WHERE user_id=$1`, user.ID).Scan(&cartAfter) != nil || cartBefore != cartAfter {
				t.Fatal("email change transferred cart ownership")
			}
			if f.pool.QueryRow(f.ctx, `SELECT credential_version FROM users WHERE id=$1`, user.ID).Scan(&version) != nil || version != 1 {
				t.Fatal("credential version did not advance once")
			}
			if _, err := confirmChange(s, f, user, passwordSessionID(t, fresh.AccessToken), proofs[order[1]]); !errors.Is(err, auth.ErrInvalidSecurityToken) {
				t.Fatal("completed proof reused")
			}
			mail.mu.Lock()
			notifications := 0
			for _, m := range mail.messages {
				if m.Subject == "Commerce Lab email changed" && (m.To == user.Email || m.To == next) {
					notifications++
				}
			}
			mail.mu.Unlock()
			if notifications != 2 {
				t.Fatal("both verified mailboxes were not notified")
			}
		})
	}
}

func TestEmailChangeRejectionsAndReplacement(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	u, tokens, sid := verificationAccount(t, f, s, "unverifiedchange")
	if _, err := s.RequestEmailChange(f.ctx, u.ID, sid, auth.EmailChangeRequest{NewEmail: "new@example.test", CurrentPassword: authTestPassword}); !errors.Is(err, auth.ErrEmailVerificationRequired) || mail.count() != 0 {
		t.Fatal("unverified email may change")
	}
	u, tokens, sid = changeAccount(t, f, s, "requestowner")
	foreign, _, foreignSID := changeAccount(t, f, s, "otherowner")
	path := "/api/v1/users/me/email-change"
	body := verificationJSON(auth.EmailChangeRequest{NewEmail: "first@example.test", CurrentPassword: authTestPassword})
	api := securityAPI(t, s)
	api.request(t, "POST", path, body, "", nil, true, 401)
	api.request(t, "POST", path, body, tokens.AccessToken, nil, false, 403)
	api.request(t, "POST", path, `{"new_email":null,"current_password":"password long enough"}`, tokens.AccessToken, nil, true, 400)
	api.request(t, "POST", path, `{"new_email":"first@example.test","current_password":"password long enough","user_id":"other"}`, tokens.AccessToken, nil, true, 400)
	for _, target := range []string{u.Email, "bad\r\nBcc: other@example.test"} {
		if _, err := s.RequestEmailChange(f.ctx, u.ID, sid, auth.EmailChangeRequest{NewEmail: target, CurrentPassword: authTestPassword}); !errors.Is(err, auth.ErrInvalidInput) {
			t.Fatal("invalid/unchanged email accepted")
		}
	}
	requestChange(t, f, s, u, sid, "first@example.test")
	first := changeProofs(t, mail, u.Email, "first@example.test")
	status, _ := s.SecurityStatus(f.ctx, u.ID)
	oldID := status.PendingEmailChange.ID
	if _, err := s.RequestEmailChange(f.ctx, u.ID, sid, auth.EmailChangeRequest{NewEmail: "second@example.test", CurrentPassword: authTestPassword}); err == nil {
		t.Fatal("cooldown missing")
	}
	if _, err := confirmChange(s, f, foreign, foreignSID, first[0]); !errors.Is(err, auth.ErrInvalidSecurityToken) {
		t.Fatal("foreign proof accepted")
	}
	if err := s.CancelEmailChange(f.ctx, foreign.ID, foreignSID, auth.EmailChangeCancellation{RequestID: oldID, CurrentPassword: authTestPassword}); !errors.Is(err, auth.ErrPendingEmailChangeMissing) {
		t.Fatal("foreign request cancellable")
	}
	allowChangeResend(t, f, u.ID)
	requestChange(t, f, s, u, sid, "second@example.test")
	second := changeProofs(t, mail, u.Email, "second@example.test")
	for _, token := range first {
		if _, err := confirmChange(s, f, u, sid, token); !errors.Is(err, auth.ErrInvalidSecurityToken) {
			t.Fatal("replaced proof accepted")
		}
	}
	if err := s.CancelEmailChange(f.ctx, u.ID, sid, auth.EmailChangeCancellation{RequestID: oldID, CurrentPassword: authTestPassword}); !errors.Is(err, auth.ErrPendingEmailChangeMissing) {
		t.Fatal("stale cancellation affected new request")
	}
	status, _ = s.SecurityStatus(f.ctx, u.ID)
	newID := status.PendingEmailChange.ID
	securityAPI(t, s).request(t, "POST", path+"/cancel", verificationJSON(auth.EmailChangeCancellation{RequestID: newID, CurrentPassword: authTestPassword}), tokens.AccessToken, nil, true, 204)
	for _, token := range second {
		if _, err := confirmChange(s, f, u, sid, token); !errors.Is(err, auth.ErrInvalidSecurityToken) {
			t.Fatal("cancelled proof accepted")
		}
	}
	allowChangeResend(t, f, u.ID)
	requestChange(t, f, s, u, sid, "expired@example.test")
	expired := changeProofs(t, mail, u.Email, "expired@example.test")
	if _, err := f.migrator.Exec(f.ctx, `UPDATE email_change_requests SET created_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND state='pending'`, u.ID); err != nil {
		t.Fatal("expiry fixture failed")
	}
	for _, token := range expired {
		if _, err := confirmChange(s, f, u, sid, token); !errors.Is(err, auth.ErrInvalidSecurityToken) {
			t.Fatal("expired request accepted")
		}
	}
	allowChangeResend(t, f, u.ID)
	requestChange(t, f, s, u, sid, "replacement@example.test")
	for range 2 {
		allowChangeResend(t, f, u.ID)
		_, err := s.RequestEmailChange(f.ctx, u.ID, sid, auth.EmailChangeRequest{NewEmail: "budget@example.test", CurrentPassword: authTestPassword})
		var limit *auth.SecurityMailLimitError
		if errors.As(err, &limit) {
			break
		}
		if err != nil {
			t.Fatal("issuance budget setup failed")
		}
	}
	allowChangeResend(t, f, u.ID)
	_, err := s.RequestEmailChange(f.ctx, u.ID, sid, auth.EmailChangeRequest{NewEmail: "blocked@example.test", CurrentPassword: authTestPassword})
	var limit *auth.SecurityMailLimitError
	if !errors.As(err, &limit) || limit.Seconds != 3600 {
		t.Fatal("persisted hourly limit missing")
	}
}

func TestEmailChangeConflictAndRollback(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	for _, conflict := range []bool{true, false} {
		t.Run(fmt.Sprint(conflict), func(t *testing.T) {
			u, tokens, sid := changeAccount(t, f, s, fmt.Sprintf("conflict%t", conflict))
			next := fmt.Sprintf("target%t@example.test", conflict)
			requestChange(t, f, s, u, sid, next)
			proof := changeProofs(t, mail, u.Email, next)
			if _, err := confirmChange(s, f, u, sid, proof[0]); err != nil {
				t.Fatal("first proof failed")
			}
			before := mail.count()
			if conflict {
				if _, err := s.Register(f.ctx, auth.Registration{FirstName: "Other", LastName: "Owner", Email: next, Password: authTestPassword}); err != nil {
					t.Fatal("registration race setup failed")
				}
			} else {
				if _, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION fail_change_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled revocation failure'; END $$; CREATE TRIGGER fail_change_revoke BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION fail_change_revoke()`); err != nil {
					t.Fatal("rollback trigger failed")
				}
			}
			_, err := confirmChange(s, f, u, sid, proof[1])
			expected := auth.ErrSecurityUnavailable
			if conflict {
				expected = auth.ErrConflict
			}
			if !errors.Is(err, expected) {
				t.Fatal("final rejection classification failed")
			}
			var address, state string
			var version int64
			var consumed bool
			if f.pool.QueryRow(f.ctx, `SELECT email,credential_version FROM users WHERE id=$1`, u.ID).Scan(&address, &version) != nil || address != u.Email || version != 0 || mail.count() != before {
				t.Fatal("failed change affected credentials or mailed notification")
			}
			if _, err := s.Authenticate(f.ctx, tokens.AccessToken); err != nil {
				t.Fatal("failed change revoked session")
			}
			if f.pool.QueryRow(f.ctx, `SELECT state FROM email_change_requests WHERE user_id=$1`, u.ID).Scan(&state) != nil {
				t.Fatal("request status read failed")
			}
			if conflict {
				if state != "conflict" {
					t.Fatal("duplicate conflict termination did not commit")
				}
				if _, err := confirmChange(s, f, u, sid, proof[1]); !errors.Is(err, auth.ErrInvalidSecurityToken) {
					t.Fatal("conflict proof reused")
				}
			} else {
				if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER fail_change_revoke ON user_sessions; DROP FUNCTION fail_change_revoke()`); err != nil {
					t.Fatal("rollback trigger cleanup failed")
				}
				hash := sha256.Sum256([]byte(proof[1]))
				if f.pool.QueryRow(f.ctx, `SELECT consumed_at IS NOT NULL FROM account_security_tokens WHERE token_hash=$1`, hash[:]).Scan(&consumed) != nil || consumed || state != "pending" {
					t.Fatal("rollback consumed final proof")
				}
				mail.fail.Store(true)
				result, err := confirmChange(s, f, u, sid, proof[1])
				mail.fail.Store(false)
				if err != nil || result.Pending || result.Change.Notification != "unconfirmed" {
					t.Fatal("notification failure undid credential change")
				}
			}
		})
	}
}

func TestEmailChangeConcurrency(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	u, _, sid := changeAccount(t, f, s, "parallelproof")
	requestChange(t, f, s, u, sid, "parallelnew@example.test")
	proofs := changeProofs(t, mail, u.Email, "parallelnew@example.test")
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan auth.EmailChangeResult, 2)
	fail := make(chan error, 2)
	for _, token := range proofs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			result, err := confirmChange(s, f, u, sid, token)
			results <- result
			fail <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(fail)
	for err := range fail {
		if err != nil {
			t.Fatal("parallel distinct proofs failed")
		}
	}
	pending := 0
	for result := range results {
		if result.Pending {
			pending++
		}
	}
	if pending != 1 {
		t.Fatal("proof race did not produce one pending and one completion")
	}
	// Two accounts may propose the same free address. The unique users index,
	// rather than an application reservation, admits one final credential update.
	var users [2]auth.User
	var sessions [2]string
	var pairs [2][2]string
	for i := range 2 {
		users[i], _, sessions[i] = changeAccount(t, f, s, fmt.Sprintf("collision%d", i))
		requestChange(t, f, s, users[i], sessions[i], "sharedtarget@example.test")
		pairs[i] = changeProofs(t, mail, users[i].Email, "sharedtarget@example.test")
		if _, err := confirmChange(s, f, users[i], sessions[i], pairs[i][0]); err != nil {
			t.Fatal("collision first proof failed")
		}
	}
	start = make(chan struct{})
	outcomes := make(chan error, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := confirmChange(s, f, users[i], sessions[i], pairs[i][1])
			outcomes <- err
		}()
	}
	close(start)
	wg.Wait()
	close(outcomes)
	wins, conflicts := 0, 0
	for err := range outcomes {
		if err == nil {
			wins++
		} else if errors.Is(err, auth.ErrConflict) {
			conflicts++
		} else {
			t.Fatal("unexpected shared-address race error")
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatal("shared address had multiple/no owners")
	}
}

func TestEmailChangeBindingsAndDisabledDelivery(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	for i, kind := range []string{"token expiry", "version", "target", "session", "password", "wrong purpose"} {
		t.Run(kind, func(t *testing.T) {
			u, _, sid := changeAccount(t, f, s, fmt.Sprintf("bindingchange%d", i))
			target := fmt.Sprintf("bindingtarget%d@example.test", i)
			wrong := ""
			if kind == "wrong purpose" {
				if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET email_verified_at=NULL WHERE id=$1`, u.ID); err != nil {
					t.Fatal("purpose fixture failed")
				}
				issueVerification(t, f, s, u, sid)
				wrong = mail.token(t)
				if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1`, u.ID); err != nil {
					t.Fatal("purpose fixture restoration failed")
				}
			}
			requestChange(t, f, s, u, sid, target)
			proof := changeProofs(t, mail, u.Email, target)
			raw := proof[0]
			var query string
			switch kind {
			case "token expiry":
				query = `UPDATE account_security_tokens SET created_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND purpose='email_change_old'`
			case "version":
				query = `UPDATE users SET credential_version=credential_version+1 WHERE id=$1`
			case "target":
				query = `UPDATE account_security_tokens SET email='tampered@example.test' WHERE user_id=$1 AND purpose='email_change_old'`
			case "session":
				query = `UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1`
			case "password":
				if _, err := s.ChangePassword(f.ctx, u.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword}); err != nil {
					t.Fatal("password setup failed")
				}
			case "wrong purpose":
				raw = wrong
			default:
				t.Fatal("unhandled binding fixture")
			}
			if query != "" {
				if _, err := f.migrator.Exec(f.ctx, query, u.ID); err != nil {
					t.Fatal("binding adjustment failed")
				}
			}
			_, err := confirmChange(s, f, u, sid, raw)
			if kind == "session" {
				if !errors.Is(err, auth.ErrUnauthorized) {
					t.Fatal("revoked session accepted")
				}
			} else if kind == "password" {
				if !errors.Is(err, auth.ErrReauthentication) && !errors.Is(err, auth.ErrUnauthorized) {
					t.Fatal("changed password accepted")
				}
			} else if !errors.Is(err, auth.ErrInvalidSecurityToken) {
				t.Fatal("invalid bound proof accepted")
			}
		})
	}
	u, _, sid := changeAccount(t, f, s, "disablechange")
	requestChange(t, f, s, u, sid, "disabletarget@example.test")
	proof := changeProofs(t, mail, u.Email, "disabletarget@example.test")
	disabled := verificationService(t, f, email.Disabled{})
	if _, err := disabled.RequestEmailChange(f.ctx, u.ID, sid, auth.EmailChangeRequest{NewEmail: "another@example.test", CurrentPassword: authTestPassword}); !errors.Is(err, auth.ErrMailDisabled) {
		t.Fatal("disabled delivery issued new proofs")
	}
	if _, err := confirmChange(disabled, f, u, sid, proof[0]); err != nil {
		t.Fatal("disabled SMTP blocked existing proof")
	}
	result, err := confirmChange(disabled, f, u, sid, proof[1])
	if err != nil || result.Change.Notification != "unconfirmed" {
		t.Fatal("disabled notification undid committed change")
	}
	cancelUser, _, cancelSID := changeAccount(t, f, s, "disabledcancel")
	requestChange(t, f, s, cancelUser, cancelSID, "cancelledtarget@example.test")
	status, _ := s.SecurityStatus(f.ctx, cancelUser.ID)
	if err := disabled.CancelEmailChange(f.ctx, cancelUser.ID, cancelSID, auth.EmailChangeCancellation{RequestID: status.PendingEmailChange.ID, CurrentPassword: authTestPassword}); err != nil {
		t.Fatal("disabled SMTP blocked cancellation")
	}
}

func TestEmailChangeRevocationRaces(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	for _, password := range []bool{false, true} {
		t.Run(fmt.Sprint(password), func(t *testing.T) {
			u, _, sid := changeAccount(t, f, s, fmt.Sprintf("revocationchange%t", password))
			target := fmt.Sprintf("revocationtarget%t@example.test", password)
			requestChange(t, f, s, u, sid, target)
			proof := changeProofs(t, mail, u.Email, target)
			if _, err := confirmChange(s, f, u, sid, proof[0]); err != nil {
				t.Fatal("first race proof failed")
			}
			status, _ := s.SecurityStatus(f.ctx, u.ID)
			requestID := status.PendingEmailChange.ID
			start := make(chan struct{})
			first := make(chan error, 1)
			second := make(chan error, 1)
			go func() { <-start; _, err := confirmChange(s, f, u, sid, proof[1]); first <- err }()
			go func() {
				<-start
				var err error
				if password {
					_, err = s.ChangePassword(f.ctx, u.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword})
				} else {
					err = s.CancelEmailChange(f.ctx, u.ID, sid, auth.EmailChangeCancellation{RequestID: requestID, CurrentPassword: authTestPassword})
				}
				second <- err
			}()
			close(start)
			a, b := <-first, <-second
			if (a == nil) == (b == nil) {
				t.Fatal("conflicting changes did not have exactly one winner")
			}
			for _, err := range []error{a, b} {
				if err != nil && !errors.Is(err, auth.ErrUnauthorized) && !errors.Is(err, auth.ErrInvalidSecurityToken) && !errors.Is(err, auth.ErrCredentialsChanged) && !errors.Is(err, auth.ErrReauthentication) {
					t.Fatal("unexpected revocation race error")
				}
			}
			var address, state string
			var version int64
			if f.pool.QueryRow(f.ctx, `SELECT email,credential_version FROM users WHERE id=$1`, u.ID).Scan(&address, &version) != nil || f.pool.QueryRow(f.ctx, `SELECT state FROM email_change_requests WHERE id=$1`, requestID).Scan(&state) != nil {
				t.Fatal("race readback failed")
			}
			if a == nil {
				if address != target || state != "completed" || version != 1 {
					t.Fatal("email winner state inconsistent")
				}
			} else {
				expectedVersion := int64(0)
				if password {
					expectedVersion = 1
				}
				if address != u.Email || state != "cancelled" || version != expectedVersion {
					t.Fatal("other winner state inconsistent")
				}
			}
		})
	}
}

func TestEmailChangeUnexpectedConstraintAndVersionLimit(t *testing.T) {
	f := newTestDatabase(t)
	mail := &captureSecurityMail{}
	s := verificationService(t, f, mail)
	u, _, sid := changeAccount(t, f, s, "unexpectedconstraint")
	requestChange(t, f, s, u, sid, "unexpectedtarget@example.test")
	proof := changeProofs(t, mail, u.Email, "unexpectedtarget@example.test")
	if _, err := confirmChange(s, f, u, sid, proof[0]); err != nil {
		t.Fatal("first proof failed")
	}
	if _, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION fail_email_constraint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled unrelated uniqueness' USING ERRCODE='23505',CONSTRAINT='other_key'; END $$; CREATE TRIGGER fail_email_constraint BEFORE UPDATE OF email ON users FOR EACH ROW EXECUTE FUNCTION fail_email_constraint()`); err != nil {
		t.Fatal("constraint fixture failed")
	}
	if _, err := confirmChange(s, f, u, sid, proof[1]); !errors.Is(err, auth.ErrSecurityUnavailable) {
		t.Fatal("unexpected uniqueness mislabeled as email conflict")
	}
	if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER fail_email_constraint ON users; DROP FUNCTION fail_email_constraint()`); err != nil {
		t.Fatal("constraint fixture cleanup failed")
	}
	if _, err := confirmChange(s, f, u, sid, proof[1]); err != nil {
		t.Fatal("unexpected failure consumed proof")
	}
	limited, _, limitedSID := changeAccount(t, f, s, "limitedchange")
	if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET credential_version=9223372036854775807 WHERE id=$1`, limited.ID); err != nil {
		t.Fatal("version fixture failed")
	}
	requestChange(t, f, s, limited, limitedSID, "limitedtarget@example.test")
	pair := changeProofs(t, mail, limited.Email, "limitedtarget@example.test")
	if _, err := confirmChange(s, f, limited, limitedSID, pair[0]); err != nil {
		t.Fatal("limited first proof failed")
	}
	if _, err := confirmChange(s, f, limited, limitedSID, pair[1]); !errors.Is(err, auth.ErrCredentialVersion) {
		t.Fatal("version limit overflowed")
	}
}

func TestEmailChangeCommitLoss(t *testing.T) {
	for _, action := range []string{"request", "first", "final", "cancel", "conflict"} {
		for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter} {
			t.Run(fmt.Sprintf("%s/%d", action, mode), func(t *testing.T) {
				f := newTestDatabase(t)
				mail := &captureSecurityMail{}
				s := verificationService(t, f, mail)
				u, _, sid := changeAccount(t, f, s, "commitowner")
				target := "commitnew@example.test"
				var proof [2]string
				var requestID string
				if action != "request" {
					requestChange(t, f, s, u, sid, target)
					proof = changeProofs(t, mail, u.Email, target)
					status, _ := s.SecurityStatus(f.ctx, u.ID)
					requestID = status.PendingEmailChange.ID
				}
				if action == "final" || action == "conflict" {
					if _, err := confirmChange(s, f, u, sid, proof[0]); err != nil {
						t.Fatal("first proof setup failed")
					}
				}
				if action == "conflict" {
					if _, err := s.Register(f.ctx, auth.Registration{FirstName: "Other", LastName: "Owner", Email: target, Password: authTestPassword}); err != nil {
						t.Fatal("conflict setup failed")
					}
				}
				pool, fault := newCommitFaultPool(t, f, mode)
				faulty, err := auth.NewService(pool, []byte(strings.Repeat("security-test-key", 2)), time.Now, auth.SecurityOptions{Sender: mail, Origin: authTestOrigin})
				if err != nil {
					t.Fatal("fault service failed")
				}
				before := mail.count()
				switch action {
				case "request":
					_, err = faulty.RequestEmailChange(f.ctx, u.ID, sid, auth.EmailChangeRequest{NewEmail: target, CurrentPassword: authTestPassword})
				case "first":
					_, err = confirmChange(faulty, f, u, sid, proof[0])
				case "final", "conflict":
					_, err = confirmChange(faulty, f, u, sid, proof[1])
				case "cancel":
					err = faulty.CancelEmailChange(f.ctx, u.ID, sid, auth.EmailChangeCancellation{RequestID: requestID, CurrentPassword: authTestPassword})
				default:
					t.Fatal("unhandled commit test")
				}
				if !errors.Is(err, auth.ErrSecurityOutcomeUnknown) {
					t.Fatal("lost commit reported definitive outcome")
				}
				awaitCommitFault(t, fault)
				if mail.count() != before {
					t.Fatal("unknown commit sent mail")
				}
				var address string
				if f.pool.QueryRow(f.ctx, `SELECT email FROM users WHERE id=$1`, u.ID).Scan(&address) != nil {
					t.Fatal("commit readback failed")
				}
				expected := u.Email
				if action == "final" && mode == commitDropAfter {
					expected = target
				}
				if address != expected {
					t.Fatal("credential commit outcome incorrect")
				}
				var count int
				if f.pool.QueryRow(f.ctx, `SELECT count(*) FROM email_change_requests WHERE user_id=$1`, u.ID).Scan(&count) != nil {
					t.Fatal("commit request readback failed")
				}
				expectedCount := 1
				if action == "request" && mode == commitDropBefore {
					expectedCount = 0
				}
				if count != expectedCount {
					t.Fatal("request commit was replayed/lost")
				}
				if count == 1 {
					var state string
					var oldConfirmed bool
					if f.pool.QueryRow(f.ctx, `SELECT state,old_confirmed_at IS NOT NULL FROM email_change_requests WHERE user_id=$1`, u.ID).Scan(&state, &oldConfirmed) != nil {
						t.Fatal("state readback failed")
					}
					if mode == commitDropAfter {
						switch action {
						case "first":
							if !oldConfirmed || state != "pending" {
								t.Fatal("first proof commit lost")
							}
						case "final":
							if state != "completed" {
								t.Fatal("completion commit lost")
							}
						case "cancel":
							if state != "cancelled" {
								t.Fatal("cancel commit lost")
							}
						case "conflict":
							if state != "conflict" {
								t.Fatal("conflict commit lost")
							}
						case "request":
							if state != "pending" {
								t.Fatal("issuance commit lost")
							}
						default:
							t.Fatal("unhandled readback")
						}
					}
				}
			})
		}
	}
}
