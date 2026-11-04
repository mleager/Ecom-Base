//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/httpserver"
	"github.com/golang-jwt/jwt/v5"
)

const replacementPassword = "  replacement test-only passphrase  "

func passwordSessionID(t *testing.T, access string) string {
	t.Helper()
	claims := jwt.MapClaims{}
	_, _, err := jwt.NewParser().ParseUnverified(access, claims)
	id, ok := claims["sid"].(string)
	if err != nil || !ok {
		t.Fatal("invalid test session claim")
	}
	return id
}

func passwordBody(current, replacement string) string {
	body, _ := json.Marshal(auth.PasswordChange{CurrentPassword: current, NewPassword: replacement})
	return string(body)
}

func securityAPI(t *testing.T, service *auth.Service) authAPI {
	t.Helper()
	handler := auth.NewHandler(service, auth.HTTPOptions{Origin: authTestOrigin})
	server := httpserver.New("127.0.0.1:8080", nil, slog.New(slog.NewTextHandler(io.Discard, nil)), handler.Routes)
	httpServer := httptest.NewServer(server.Handler)
	t.Cleanup(httpServer.Close)
	return authAPI{httpServer}
}

func TestAccountPasswordSecurity(t *testing.T) {
	f := newTestDatabase(t)
	service, err := auth.NewService(f.pool, []byte(strings.Repeat("security-test-key", 2)), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.Register(f.ctx, auth.Registration{FirstName: "Test", LastName: "Customer", Email: "security@example.test", Password: authTestPassword})
	if err != nil {
		t.Fatal(err)
	}
	login := func() auth.Tokens {
		tokens, err := service.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword})
		if err != nil {
			t.Fatal(err)
		}
		return tokens
	}
	first, second := login(), login()
	api := securityAPI(t, service)
	t.Run("strict input, authentication, CSRF and reauthentication reject without revocation", func(t *testing.T) {
		api.request(t, "POST", "/api/v1/users/me/password", passwordBody(authTestPassword, replacementPassword), "", nil, true, 401)
		api.request(t, "POST", "/api/v1/users/me/password", passwordBody(authTestPassword, replacementPassword), first.AccessToken, nil, false, 403)
		for _, body := range []string{`{}`, `{"current_password":null,"new_password":"something long enough"}`, `{"current_password":"one","current_password":"two","new_password":"three"}`, `{"current_password":"one","new_password":"two","user_id":"other"}`} {
			api.request(t, "POST", "/api/v1/users/me/password", body, first.AccessToken, nil, true, 400)
		}
		// Each HTTP handler owns its own limiter; rejected input must not consume the
		// success fixture's subsequent five-attempt budget.
		validationAPI := securityAPI(t, service)
		validationAPI.request(t, "POST", "/api/v1/users/me/password", passwordBody("wrong password long enough", replacementPassword), first.AccessToken, nil, true, 403)
		validationAPI.request(t, "POST", "/api/v1/users/me/password", passwordBody(authTestPassword, authTestPassword), first.AccessToken, nil, true, 422)
		validationAPI.request(t, "POST", "/api/v1/users/me/password", passwordBody(authTestPassword, "too short"), first.AccessToken, nil, true, 422)
		if _, err := service.Authenticate(f.ctx, second.AccessToken); err != nil {
			t.Fatal("rejected writes revoked a session")
		}
	})
	t.Run("version exhaustion rolls back safely", func(t *testing.T) {
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET credential_version=$2 WHERE id=$1`, user.ID, int64(math.MaxInt64)); err != nil {
			t.Fatal(err)
		}
		api.request(t, "POST", "/api/v1/users/me/password", passwordBody(authTestPassword, replacementPassword), first.AccessToken, nil, true, 409)
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET credential_version=0 WHERE id=$1`, user.ID); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("failure during revocation rolls back password and version", func(t *testing.T) {
		_, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION fail_security_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled security failure'; END $$;
CREATE TRIGGER fail_security_revoke BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION fail_security_revoke()`)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, err := f.migrator.Exec(f.ctx, `DROP TRIGGER fail_security_revoke ON user_sessions; DROP FUNCTION fail_security_revoke()`)
			if err != nil {
				t.Error("security trigger cleanup failed")
			}
		})
		securityAPI(t, service).request(t, "POST", "/api/v1/users/me/password", passwordBody(authTestPassword, replacementPassword), first.AccessToken, nil, true, 503)
		var version int64
		if err := f.pool.QueryRow(f.ctx, `SELECT credential_version FROM users WHERE id=$1`, user.ID).Scan(&version); err != nil || version != 0 {
			t.Fatal("failed revocation persisted credential version")
		}
		if _, err := service.Authenticate(f.ctx, first.AccessToken); err != nil {
			t.Fatal("failed revocation affected caller session")
		}
		if _, err := service.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword}); err != nil {
			t.Fatal("failed revocation persisted replacement password")
		}
	})
	t.Run("security attempts have an independent per-user rate limit", func(t *testing.T) {
		limited := securityAPI(t, service)
		for attempt := 0; attempt < 6; attempt++ {
			status := 403
			if attempt == 5 {
				status = 429
			}
			response := limited.request(t, "POST", "/api/v1/users/me/password", passwordBody("incorrect current passphrase", replacementPassword), first.AccessToken, nil, true, status)
			if status == 429 && response.headers.Get("Retry-After") == "" {
				t.Fatal("security throttle missing retry guidance")
			}
		}
	})
	t.Run("atomic password replacement revokes every session and preserves whitespace", func(t *testing.T) {
		api = securityAPI(t, service)
		response := api.request(t, "POST", "/api/v1/users/me/password", passwordBody(authTestPassword, replacementPassword), first.AccessToken, nil, true, 200)
		var result auth.SecurityChangeResult
		if json.Unmarshal(response.body, &result) != nil || !result.ReauthenticationRequired || result.Notification != "not_applicable" {
			t.Fatal("invalid security result")
		}
		if len(response.cookies) != 1 || response.cookies[0].MaxAge != -1 || response.cookies[0].Path != "/api/v1/auth" || !response.cookies[0].HttpOnly {
			t.Fatal("refresh cookie not cleared")
		}
		var version, live int64
		if err := f.pool.QueryRow(f.ctx, `SELECT credential_version FROM users WHERE id=$1`, user.ID).Scan(&version); err != nil || version != 1 {
			t.Fatal("credential version did not advance once")
		}
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL`, user.ID).Scan(&live); err != nil || live != 0 {
			t.Fatal("session revocation incomplete")
		}
		for _, old := range []auth.Tokens{first, second} {
			if _, err := service.Authenticate(f.ctx, old.AccessToken); !errors.Is(err, auth.ErrUnauthorized) {
				t.Fatal("old JWT still accepted")
			}
			if _, err := service.Refresh(f.ctx, old.Refresh); !errors.Is(err, auth.ErrUnauthorized) {
				t.Fatal("old refresh still accepted")
			}
		}
		for _, password := range []string{authTestPassword, strings.TrimSpace(replacementPassword)} {
			if _, err := service.Login(f.ctx, auth.Credentials{Email: user.Email, Password: password}); !errors.Is(err, auth.ErrUnauthorized) {
				t.Fatal("wrong/trimmed password accepted")
			}
		}
		if _, err := service.Login(f.ctx, auth.Credentials{Email: user.Email, Password: replacementPassword}); err != nil {
			t.Fatal("replacement password rejected")
		}
	})
}

func TestPasswordSecurityCommitLoss(t *testing.T) {
	for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter} {
		t.Run(fmt.Sprint(mode), func(t *testing.T) {
			f := newTestDatabase(t)
			secret := []byte(strings.Repeat("security-test-key", 2))
			service, err := auth.NewService(f.pool, secret, time.Now)
			if err != nil {
				t.Fatal(err)
			}
			user, err := service.Register(f.ctx, auth.Registration{FirstName: "Test", LastName: "Customer", Email: "commit@example.test", Password: authTestPassword})
			if err != nil {
				t.Fatal(err)
			}
			tokens, err := service.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword})
			if err != nil {
				t.Fatal(err)
			}
			pool, fault := newCommitFaultPool(t, f, mode)
			faulty, err := auth.NewService(pool, secret, time.Now)
			if err != nil {
				t.Fatal(err)
			}
			response := securityAPI(t, faulty).request(t, "POST", "/api/v1/users/me/password", passwordBody(authTestPassword, replacementPassword), tokens.AccessToken, nil, true, 503)
			awaitCommitFault(t, fault)
			if len(response.cookies) != 0 || !strings.Contains(string(response.body), "security_outcome_unknown") {
				t.Fatal("unknown commit claimed a definitive outcome")
			}
			var version int64
			if err := f.pool.QueryRow(f.ctx, `SELECT credential_version FROM users WHERE id=$1`, user.ID).Scan(&version); err != nil {
				t.Fatal(err)
			}
			expected := int64(0)
			if mode == commitDropAfter {
				expected = 1
			}
			if version != expected {
				t.Fatal("fault did not exercise the expected commit outcome")
			}
			_, authErr := service.Authenticate(f.ctx, tokens.AccessToken)
			if (authErr == nil) != (expected == 0) {
				t.Fatal("session state diverged from credential commit")
			}
		})
	}
}

func TestPasswordSecurityRaces(t *testing.T) {
	f := newTestDatabase(t)
	service, err := auth.NewService(f.pool, []byte(strings.Repeat("security-test-key", 2)), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	for round := 0; round < 3; round++ {
		user, err := service.Register(f.ctx, auth.Registration{FirstName: "Test", LastName: "Customer", Email: strings.Repeat("x", round+1) + "@race.test", Password: authTestPassword})
		if err != nil {
			t.Fatal(err)
		}
		first, err := service.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword})
		if err != nil {
			t.Fatal(err)
		}
		sid := passwordSessionID(t, first.AccessToken)
		other, err := service.Login(f.ctx, auth.Credentials{Email: user.Email, Password: authTestPassword})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(f.ctx, 8*time.Second)
		start := make(chan struct{})
		var wait sync.WaitGroup
		var changeErr error
		wait.Add(5)
		go func() { defer wait.Done(); <-start; _ = service.Logout(ctx, other.Refresh) }()
		go func() {
			defer wait.Done()
			<-start
			_, changeErr = service.ChangePassword(ctx, user.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword})
		}()
		go func() { defer wait.Done(); <-start; _, _ = service.Refresh(ctx, first.Refresh) }()
		go func() {
			defer wait.Done()
			<-start
			_, _ = service.Login(ctx, auth.Credentials{Email: user.Email, Password: authTestPassword})
		}()
		go func() {
			defer wait.Done()
			<-start
			_, _ = service.ChangePassword(ctx, user.ID, sid, auth.PasswordChange{CurrentPassword: authTestPassword, NewPassword: replacementPassword})
		}()
		close(start)
		wait.Wait()
		cancel()
		if changeErr != nil && !errors.Is(changeErr, auth.ErrUnauthorized) && !errors.Is(changeErr, auth.ErrReauthentication) && !errors.Is(changeErr, auth.ErrCapacity) {
			t.Fatal("credential race failed outside expected rejection policy")
		}
		var version int64
		if err := f.pool.QueryRow(f.ctx, `SELECT credential_version FROM users WHERE id=$1`, user.ID).Scan(&version); err != nil || version != 1 {
			t.Fatal("concurrent changes did not produce exactly one password update")
		}
		if _, err := service.Refresh(f.ctx, first.Refresh); !errors.Is(err, auth.ErrUnauthorized) {
			t.Fatal("raced session survived password change")
		}
		var live int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL`, user.ID).Scan(&live); err != nil || live != 0 {
			t.Fatal("raced login escaped session revocation")
		}
	}
}
