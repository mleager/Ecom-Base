//go:build integration

package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/argon2"
)

const authTestPassword = "a long test-only passphrase  "
const authTestOrigin = "http://localhost:5173"

type authAPI struct{ server *httptest.Server }
type authResponse struct {
	status  int
	body    []byte
	headers http.Header
	cookies []*http.Cookie
}

func (api authAPI) do(method, path, body, bearer string, cookie *http.Cookie, csrf bool) (authResponse, error) {
	r, err := http.NewRequest(method, api.server.URL+path, strings.NewReader(body))
	if err != nil {
		return authResponse{}, err
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if csrf {
		r.Header.Set("Origin", authTestOrigin)
		r.Header.Set("X-CSRF-Protection", "1")
	}
	response, err := api.server.Client().Do(r)
	if err != nil {
		return authResponse{}, err
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(response.Body)
	return authResponse{response.StatusCode, data, response.Header, response.Cookies()}, err
}

func (api authAPI) request(t *testing.T, method, path, body, bearer string, cookie *http.Cookie, csrf bool, status int) authResponse {
	t.Helper()
	response, err := api.do(method, path, body, bearer, cookie, csrf)
	if err != nil || response.status != status {
		t.Fatalf("%s %s: status=%d, expected=%d, transport error=%v", method, path, response.status, status, err)
	}
	if response.headers.Get("Cache-Control") != "no-store" {
		t.Fatal("authentication response permits caching")
	}
	return response
}

func registrationBody(email string) string {
	data, _ := json.Marshal(auth.Registration{FirstName: " Test ", LastName: " Customer ", Email: email, Password: authTestPassword})
	return string(data)
}

func credentialsBody(email, password string) string {
	data, _ := json.Marshal(auth.Credentials{Email: email, Password: password})
	return string(data)
}

func decodeTokens(t *testing.T, response authResponse) (auth.Tokens, *http.Cookie) {
	t.Helper()
	var tokens auth.Tokens
	if err := json.Unmarshal(response.body, &tokens); err != nil || tokens.AccessToken == "" || tokens.ExpiresIn != 900 || tokens.TokenType != "Bearer" || len(response.cookies) != 1 {
		t.Fatal("invalid access token response shape")
	}
	cookie := response.cookies[0]
	if !cookie.HttpOnly || cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/api/v1/auth" || cookie.Domain != "" || len(cookie.Value) != 43 {
		t.Fatal("invalid local refresh cookie")
	}
	if bytes.Contains(response.body, []byte(cookie.Value)) {
		t.Fatal("refresh token leaked into response body")
	}
	return tokens, cookie
}

func TestAuthentication(t *testing.T) {
	f := newTestDatabase(t)
	secret := []byte(strings.Repeat("test-key", 4))
	service, err := auth.NewService(f.pool, secret, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	newAPI := func(t *testing.T) authAPI {
		t.Helper()
		handler := auth.NewHandler(service, auth.HTTPOptions{Origin: authTestOrigin})
		server := httpserver.New("127.0.0.1:8080", func(ctx context.Context) error { return database.Ready(ctx, f.pool) }, slog.New(slog.NewJSONHandler(&logs, nil)), handler.Routes)
		httpServer := httptest.NewServer(server.Handler)
		t.Cleanup(httpServer.Close)
		return authAPI{httpServer}
	}
	registerLogin := func(t *testing.T, api authAPI, email string) (auth.User, auth.Tokens, *http.Cookie) {
		t.Helper()
		registration := api.request(t, "POST", "/api/v1/auth/register", registrationBody(email), "", nil, false, 201)
		var user auth.User
		if err := json.Unmarshal(registration.body, &user); err != nil || user.Role != "customer" || user.ID == "" {
			t.Fatal("invalid customer registration")
		}
		login := api.request(t, "POST", "/api/v1/auth/login", credentialsBody(email, authTestPassword), "", nil, true, 200)
		tokens, cookie := decodeTokens(t, login)
		return user, tokens, cookie
	}

	t.Run("customer cart and current authorization", func(t *testing.T) {
		api := newAPI(t)
		user, tokens, cookie := registerLogin(t, api, "  CUSTOMER@EXAMPLE.COM ")
		if user.Email != "customer@example.com" || user.FirstName != "Test" || user.LastName != "Customer" {
			t.Fatal("customer identity was not canonicalized")
		}
		api.request(t, "POST", "/api/v1/auth/register", registrationBody("Customer@example.com"), "", nil, false, 409)
		var hash string
		var cartCount int
		if err := f.migrator.QueryRow(f.ctx, `SELECT password_hash, (SELECT count(*) FROM carts WHERE user_id=users.id) FROM users WHERE id=$1`, user.ID).Scan(&hash, &cartCount); err != nil || cartCount != 1 || !strings.HasPrefix(hash, "$argon2id$v=19$m=65536,t=3,p=1$") || strings.Contains(hash, authTestPassword) {
			t.Fatal("registration did not store a hash and exactly one cart")
		}
		var storedVerifier string
		var expires, created time.Time
		if err := f.migrator.QueryRow(f.ctx, `SELECT refresh_token_hash, expires_at, created_at FROM user_sessions WHERE user_id=$1`, user.ID).Scan(&storedVerifier, &expires, &created); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256([]byte(cookie.Value))
		if storedVerifier != hex.EncodeToString(digest[:]) || expires.Sub(created) != auth.SessionLifetime {
			t.Fatalf("verifier match=%v; observed lifetime=%s", storedVerifier == hex.EncodeToString(digest[:]), expires.Sub(created))
		}
		me := api.request(t, "GET", "/api/v1/users/me", "", tokens.AccessToken, nil, false, 200)
		var self auth.User
		if err := json.Unmarshal(me.body, &self); err != nil || self.ID != user.ID || bytes.Contains(me.body, []byte("password")) {
			t.Fatal("authenticated profile is incorrect or exposes credentials")
		}
		api.request(t, "GET", "/api/v1/users/me", "", "", cookie, false, 401)
		api.request(t, "GET", "/metrics", "", tokens.AccessToken, nil, false, 403)
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET role='admin' WHERE id=$1`, user.ID); err != nil {
			t.Fatal(err)
		}
		metrics := api.request(t, "GET", "/metrics", "", tokens.AccessToken, nil, false, 200)
		if !bytes.Contains(metrics.body, []byte("ecom_authenticated_requests_total")) {
			t.Fatal("admin metrics missing real authentication counter")
		}
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET role='customer', is_active=false WHERE id=$1`, user.ID); err != nil {
			t.Fatal(err)
		}
		api.request(t, "GET", "/api/v1/users/me", "", tokens.AccessToken, nil, false, 401)
		api.request(t, "POST", "/api/v1/auth/login", credentialsBody(user.Email, authTestPassword), "", nil, true, 401)
		api.request(t, "POST", "/api/v1/auth/refresh", "", "", cookie, true, 401)
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET is_active=true WHERE id=$1`, user.ID); err != nil {
			t.Fatal(err)
		}
		api.request(t, "GET", "/metrics", "", tokens.AccessToken, nil, false, 403)
		logout := api.request(t, "POST", "/api/v1/auth/logout", "", "", cookie, true, 204)
		if len(logout.cookies) != 1 || logout.cookies[0].MaxAge != -1 || logout.cookies[0].Path != cookie.Path {
			t.Fatal("logout did not clear the cookie")
		}
		api.request(t, "GET", "/api/v1/users/me", "", tokens.AccessToken, nil, false, 401)
		api.request(t, "POST", "/api/v1/auth/logout", "", "", nil, true, 204)
	})
	t.Run("duplicate signup race", func(t *testing.T) {
		api := newAPI(t)
		type result struct {
			response authResponse
			err      error
		}
		results := make(chan result, 2)
		start := make(chan struct{})
		for i := 0; i < 2; i++ {
			go func() {
				<-start
				response, err := api.do("POST", "/api/v1/auth/register", registrationBody("race@example.com"), "", nil, false)
				results <- result{response, err}
			}()
		}
		close(start)
		statuses := make(map[int]int)
		for i := 0; i < 2; i++ {
			result := <-results
			if result.err != nil {
				t.Fatal(result.err)
			}
			statuses[result.response.status]++
		}
		if statuses[201] != 1 || statuses[409] != 1 {
			t.Fatal("duplicate registration was not atomic")
		}
		var users, carts int
		if err := f.migrator.QueryRow(f.ctx, `SELECT count(*), (SELECT count(*) FROM carts JOIN users ON users.id=carts.user_id WHERE email='race@example.com') FROM users WHERE email='race@example.com'`).Scan(&users, &carts); err != nil || users != 1 || carts != 1 {
			t.Fatal("signup race created duplicate or missing records")
		}
	})
	t.Run("registration rollback", func(t *testing.T) {
		api := newAPI(t)
		if _, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION auth_test_fail_cart() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cart failure'; END; $$;
CREATE TRIGGER auth_test_fail_cart BEFORE INSERT ON carts FOR EACH ROW EXECUTE FUNCTION auth_test_fail_cart();`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, err := f.migrator.Exec(f.ctx, `DROP TRIGGER auth_test_fail_cart ON carts; DROP FUNCTION auth_test_fail_cart();`)
			if err != nil {
				t.Error(err)
			}
		}()
		response := api.request(t, "POST", "/api/v1/auth/register", registrationBody("rollback@example.com"), "", nil, false, 500)
		var count int
		if err := f.migrator.QueryRow(f.ctx, `SELECT count(*) FROM users WHERE email='rollback@example.com'`).Scan(&count); err != nil || count != 0 || bytes.Contains(response.body, []byte("injected")) {
			t.Fatal("failed registration persisted a user or exposed a SQL error")
		}
	})
	t.Run("refresh concurrency and scoped logout", func(t *testing.T) {
		api := newAPI(t)
		user, original, cookie := registerLogin(t, api, "refresh@example.com")
		var expiry time.Time
		if err := f.migrator.QueryRow(f.ctx, `SELECT expires_at FROM user_sessions WHERE user_id=$1`, user.ID).Scan(&expiry); err != nil {
			t.Fatal(err)
		}
		type result struct {
			response authResponse
			err      error
		}
		results := make(chan result, 2)
		start := make(chan struct{})
		for i := 0; i < 2; i++ {
			go func() {
				<-start
				response, err := api.do("POST", "/api/v1/auth/refresh", "", "", cookie, true)
				results <- result{response, err}
			}()
		}
		close(start)
		var winner authResponse
		statuses := make(map[int]int)
		for i := 0; i < 2; i++ {
			result := <-results
			if result.err != nil {
				t.Fatal(result.err)
			}
			statuses[result.response.status]++
			if result.response.status == 200 {
				winner = result.response
			}
			if result.response.status == 401 && result.response.headers.Get("Set-Cookie") != "" {
				t.Fatal("loser cleared the winner's cookie")
			}
		}
		if statuses[200] != 1 || statuses[401] != 1 {
			t.Fatal("concurrent refresh did not have exactly one winner")
		}
		rotated, rotatedCookie := decodeTokens(t, winner)
		if rotatedCookie.Value == cookie.Value {
			t.Fatal("refresh did not rotate its secret")
		}
		api.request(t, "POST", "/api/v1/auth/refresh", "", "", cookie, true, 401)
		api.request(t, "GET", "/api/v1/users/me", "", rotated.AccessToken, nil, false, 200)
		var after time.Time
		var sessions int
		if err := f.migrator.QueryRow(f.ctx, `SELECT expires_at, (SELECT count(*) FROM user_sessions WHERE user_id=$1) FROM user_sessions WHERE user_id=$1`, user.ID).Scan(&after, &sessions); err != nil || !expiry.Equal(after) || sessions != 1 {
			t.Fatal("refresh extended expiry or created a session")
		}
		secondLogin := api.request(t, "POST", "/api/v1/auth/login", credentialsBody(user.Email, authTestPassword), "", nil, true, 200)
		independent, _ := decodeTokens(t, secondLogin)
		api.request(t, "POST", "/api/v1/auth/logout", "", "", rotatedCookie, true, 204)
		api.request(t, "GET", "/api/v1/users/me", "", rotated.AccessToken, nil, false, 401)
		api.request(t, "GET", "/api/v1/users/me", "", original.AccessToken, nil, false, 401)
		api.request(t, "GET", "/api/v1/users/me", "", independent.AccessToken, nil, false, 200)
	})
	t.Run("reused refresh token revokes after the grace period", func(t *testing.T) {
		api := newAPI(t)
		user, _, first := registerLogin(t, api, "refresh-reuse@example.com")
		other := api.request(t, "POST", "/api/v1/auth/login", credentialsBody(user.Email, authTestPassword), "", nil, true, 200)
		otherTokens, _ := decodeTokens(t, other)
		rotated, second := decodeTokens(t, api.request(t, "POST", "/api/v1/auth/refresh", "", "", first, true, 200))
		var session string
		if err := f.migrator.QueryRow(f.ctx, `SELECT id::text FROM user_sessions WHERE previous_refresh_token_hash IS NOT NULL AND user_id=$1`, user.ID).Scan(&session); err != nil {
			t.Fatal(err)
		}
		// Within 30 seconds the old token is a race between tabs: 401, and
		// the session goes on.
		if r := api.request(t, "POST", "/api/v1/auth/refresh", "", "", first, true, 401); r.headers.Get("Set-Cookie") != "" {
			t.Fatal("a refresh that lost the race cleared the cookie")
		}
		api.request(t, "GET", "/api/v1/users/me", "", rotated.AccessToken, nil, false, 200)
		// Later, the old token was copied: the session ends for every holder.
		if _, err := f.migrator.Exec(f.ctx, `UPDATE user_sessions SET rotated_at=rotated_at-interval '31 seconds' WHERE id=$1`, session); err != nil {
			t.Fatal(err)
		}
		api.request(t, "POST", "/api/v1/auth/refresh", "", "", first, true, 401)
		api.request(t, "GET", "/api/v1/users/me", "", rotated.AccessToken, nil, false, 401)
		api.request(t, "POST", "/api/v1/auth/refresh", "", "", second, true, 401)
		var revoked bool
		if err := f.migrator.QueryRow(f.ctx, `SELECT revoked_at IS NOT NULL FROM user_sessions WHERE id=$1`, session).Scan(&revoked); err != nil || !revoked {
			t.Fatal("reuse did not revoke the session")
		}
		// The customer's other session is unaffected.
		api.request(t, "GET", "/api/v1/users/me", "", otherTokens.AccessToken, nil, false, 200)

		// Only the latest replaced token is kept: an older one gets 401 and
		// revokes nothing.
		_, _, d0 := registerLogin(t, api, "refresh-older@example.com")
		_, d1 := decodeTokens(t, api.request(t, "POST", "/api/v1/auth/refresh", "", "", d0, true, 200))
		_, d2 := decodeTokens(t, api.request(t, "POST", "/api/v1/auth/refresh", "", "", d1, true, 200))
		if _, err := f.migrator.Exec(f.ctx, `UPDATE user_sessions s SET rotated_at=rotated_at-interval '31 seconds' FROM users u WHERE u.id=s.user_id AND u.email='refresh-older@example.com'`); err != nil {
			t.Fatal(err)
		}
		api.request(t, "POST", "/api/v1/auth/refresh", "", "", d0, true, 401)
		api.request(t, "POST", "/api/v1/auth/refresh", "", "", d2, true, 200)
	})
	t.Run("failed refresh leaves original verifier", func(t *testing.T) {
		api := newAPI(t)
		_, _, cookie := registerLogin(t, api, "refresh-fault@example.com")
		if _, err := f.migrator.Exec(f.ctx, `CREATE FUNCTION auth_test_fail_rotation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected rotation failure'; END; $$;
CREATE TRIGGER auth_test_fail_rotation BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION auth_test_fail_rotation();`); err != nil {
			t.Fatal(err)
		}
		response := api.request(t, "POST", "/api/v1/auth/refresh", "", "", cookie, true, 500)
		if _, err := f.migrator.Exec(f.ctx, `DROP TRIGGER auth_test_fail_rotation ON user_sessions; DROP FUNCTION auth_test_fail_rotation();`); err != nil {
			t.Fatal(err)
		}
		if response.headers.Get("Set-Cookie") != "" {
			t.Fatal("failed rotation wrote a replacement cookie")
		}
		api.request(t, "POST", "/api/v1/auth/refresh", "", "", cookie, true, 200)
	})
	t.Run("expired session and subject binding", func(t *testing.T) {
		api := newAPI(t)
		user, tokens, cookie := registerLogin(t, api, "expired@example.com")
		otherRegistration := api.request(t, "POST", "/api/v1/auth/register", registrationBody("another-customer@example.com"), "", nil, false, 201)
		var other auth.User
		if err := json.Unmarshal(otherRegistration.body, &other); err != nil {
			t.Fatal(err)
		}
		claims := jwt.MapClaims{}
		if _, _, err := jwt.NewParser().ParseUnverified(tokens.AccessToken, claims); err != nil {
			t.Fatal(err)
		}
		claims["sub"] = other.ID
		forged, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
		if err != nil {
			t.Fatal(err)
		}
		api.request(t, "GET", "/api/v1/users/me", "", forged, nil, false, 401)
		claims["sub"], claims["role"] = user.ID, "admin"
		forged, err = jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
		if err != nil {
			t.Fatal(err)
		}
		api.request(t, "GET", "/metrics", "", forged, nil, false, 403)
		if _, err := f.migrator.Exec(f.ctx, `UPDATE user_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1`, user.ID); err != nil {
			t.Fatal(err)
		}
		api.request(t, "GET", "/api/v1/users/me", "", tokens.AccessToken, nil, false, 401)
		response := api.request(t, "POST", "/api/v1/auth/refresh", "", "", cookie, true, 401)
		if response.headers.Get("Set-Cookie") != "" {
			t.Fatal("expired refresh wrote a cookie")
		}
	})
	t.Run("generic login and rehash", func(t *testing.T) {
		api := newAPI(t)
		user, _, _ := registerLogin(t, api, "rehash@example.com")
		wrong := api.request(t, "POST", "/api/v1/auth/login", credentialsBody(user.Email, strings.TrimSpace(authTestPassword)), "", nil, true, 401)
		missing := api.request(t, "POST", "/api/v1/auth/login", credentialsBody("missing@example.com", authTestPassword), "", nil, true, 401)
		if !bytes.Equal(wrong.body, missing.body) {
			t.Fatal("login errors disclose account existence")
		}
		salt := []byte("0123456789abcdef")
		legacyKey := argon2.IDKey([]byte(authTestPassword), salt, 2, 19*1024, 1, 32)
		legacy := fmt.Sprintf("$argon2id$v=19$m=19456,t=2,p=1$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(legacyKey))
		if _, err := f.migrator.Exec(f.ctx, `UPDATE users SET password_hash=$2 WHERE id=$1`, user.ID, legacy); err != nil {
			t.Fatal(err)
		}
		api.request(t, "POST", "/api/v1/auth/login", credentialsBody(user.Email, authTestPassword), "", nil, true, 200)
		var upgraded string
		if err := f.migrator.QueryRow(f.ctx, `SELECT password_hash FROM users WHERE id=$1`, user.ID).Scan(&upgraded); err != nil || !strings.HasPrefix(upgraded, "$argon2id$v=19$m=65536,t=3,p=1$") {
			t.Fatal("successful login did not upgrade password verifier")
		}
	})
	t.Run("role input and runtime privilege denial", func(t *testing.T) {
		api := newAPI(t)
		body := strings.TrimSuffix(registrationBody("escalate@example.com"), "}") + `,"role":"admin"}`
		api.request(t, "POST", "/api/v1/auth/register", body, "", nil, false, 400)
		tx, err := f.pool.Begin(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(f.ctx) }()
		if _, err := tx.Exec(f.ctx, `UPDATE users SET role='admin' WHERE email='customer@example.com'`); err == nil {
			t.Fatal("runtime SQL can grant administrator role")
		}
	})
	t.Run("email rate limit", func(t *testing.T) {
		api := newAPI(t)
		for i := 0; i < 6; i++ {
			status := 401
			if i == 5 {
				status = 429
			}
			response := api.request(t, "POST", "/api/v1/auth/login", credentialsBody("rate@example.com", authTestPassword), "", nil, true, status)
			if status == 429 && response.headers.Get("Retry-After") == "" {
				t.Fatal("rate limit lacks retry guidance")
			}
		}
	})
	if strings.Contains(logs.String(), authTestPassword) || strings.Contains(logs.String(), "Bearer ") || strings.Contains(logs.String(), "refresh_token_hash") {
		t.Fatal("request logs disclosed authentication secrets")
	}
}
