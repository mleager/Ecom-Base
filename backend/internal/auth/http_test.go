package auth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestStrictJSON(t *testing.T) {
	for _, tc := range []struct {
		body, contentType string
		status            int
	}{
		{`{"email":"user@example.com","password":"a long passphrase"}`, "application/json", 0},
		{`{"email":"user@example.com","password":"a long passphrase"}`, "application/json; charset=utf-8", 0},
		{`{"email":"user@example.com","password":"secret","role":"admin"}`, "application/json", 400},
		{`{"email":null,"password":"secret"}`, "application/json", 400},
		{`{"email":"one","email":"two","password":"secret"}`, "application/json", 400},
		{`{"email":"one","password":42}`, "application/json", 400},
		{`{"email":"one"}`, "application/json", 400},
		{`{"email":"one","password":"secret"} {}`, "application/json", 400},
		{`[]`, "application/json", 400}, {`null`, "application/json", 400},
		{`{"email":`, "application/json", 400},
		{strings.Repeat("x", 65537), "application/json", 413},
		{`{}`, "text/plain", 400},
	} {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
		request.Header.Set("Content-Type", tc.contentType)
		response := httptest.NewRecorder()
		var input Credentials
		accepted := decode(response, request, &input, "email", "password")
		if accepted != (tc.status == 0) || (!accepted && response.Code != tc.status) {
			t.Fatalf("JSON acceptance=%v, status=%d, want status=%d", accepted, response.Code, tc.status)
		}
		if !accepted && strings.Contains(response.Body.String(), "secret") {
			t.Fatal("validation error echoed input")
		}
	}
}

func TestCSRFAndCORS(t *testing.T) {
	h := NewHandler(&Service{now: time.Now}, HTTPOptions{Origin: "http://localhost:5173"})
	router := chi.NewRouter()
	h.Routes(router)
	for _, tc := range []struct {
		method, path, origin, csrf string
		status                     int
	}{
		{"POST", "/api/v1/auth/login", "", "", 403},
		{"POST", "/api/v1/auth/refresh", "null", "1", 403},
		{"POST", "/api/v1/auth/logout", "https://untrusted.example", "1", 403},
		{"POST", "/api/v1/auth/logout", "http://localhost:5173", "", 403},
		{"POST", "/api/v1/auth/login", "http://localhost:5173", "1", 400},
		{"OPTIONS", "/api/v1/users/me", "http://localhost:5173", "", 204},
		{"OPTIONS", "/api/v1/users/me", "https://untrusted.example", "", 403},
		{"GET", "/api/v1/users/me", "", "", 401},
		{"GET", "/metrics", "", "", 401},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if tc.csrf != "" {
			r.Header.Set("X-CSRF-Protection", tc.csrf)
		}
		r.Header.Set("Access-Control-Request-Method", "GET")
		r.Header.Set("Access-Control-Request-Headers", "Authorization, X-CSRF-Protection")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: got %d, want %d", tc.method, tc.path, w.Code, tc.status)
		}
		if tc.status == 204 && (w.Header().Get("Access-Control-Allow-Origin") != tc.origin || w.Header().Get("Access-Control-Allow-Credentials") != "true") {
			t.Fatal("credentialed preflight was not exact-origin scoped")
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("authentication response can be cached")
		}
	}
}

func TestRoleGuard(t *testing.T) {
	for _, role := range []string{"", "customer", "admin"} {
		r := httptest.NewRequest(http.MethodGet, "/metrics", nil)
		if role != "" {
			r = r.WithContext(context.WithValue(r.Context(), principalKey{}, User{Role: role}))
		}
		w := httptest.NewRecorder()
		RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(w, r)
		want := 401
		if role == "customer" {
			want = 403
		}
		if role == "admin" {
			want = 204
		}
		if w.Code != want {
			t.Fatal("role guard accepted an unauthorized principal")
		}
	}
}

func TestLimiterConcurrencyCapacityAndExpiry(t *testing.T) {
	l := newLimiter(5)
	now := time.Now()
	var accepted atomic.Int64
	var group sync.WaitGroup
	for i := 0; i < 50; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if l.allow("one", now) {
				accepted.Add(1)
			}
		}()
	}
	group.Wait()
	if accepted.Load() != 5 {
		t.Fatal("concurrent limit was exceeded")
	}
	for i := 1; i < 10000; i++ {
		if !l.allow(strconv.Itoa(i), now) {
			t.Fatal("unexpected early capacity rejection")
		}
	}
	if l.allow("new", now) || len(l.entries) != 10000 {
		t.Fatal("limiter capacity is not bounded")
	}
	if !l.allow("new", now.Add(time.Minute)) || len(l.entries) != 1 {
		t.Fatal("expired keys were not removed")
	}
}

func TestCookieAttributesAndPeerAddress(t *testing.T) {
	now := time.Now()
	for _, secure := range []bool{false, true} {
		h := NewHandler(&Service{now: func() time.Time { return now }}, HTTPOptions{SecureCookies: secure})
		w := httptest.NewRecorder()
		raw, err := refreshToken()
		if err != nil {
			t.Fatal(err)
		}
		h.writeTokens(w, Tokens{AccessToken: "not-a-real-access-token", Refresh: raw, ExpiresAt: now.Add(SessionLifetime)})
		cookie := w.Result().Cookies()[0]
		if cookie.Secure != secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/api/v1/auth" || cookie.Domain != "" || cookie.MaxAge != 0 || !cookie.Expires.Equal(now.Add(SessionLifetime).UTC().Truncate(time.Second)) {
			t.Fatal("invalid refresh cookie attributes")
		}
		if strings.Contains(w.Body.String(), raw) {
			t.Fatal("refresh token leaked into JSON")
		}
	}
	validRefresh, err := refreshToken()
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.AddCookie(&http.Cookie{Name: refreshCookieName, Value: validRefresh})
	r.AddCookie(&http.Cookie{Name: refreshCookieName, Value: validRefresh})
	if _, err := readRefreshCookie(r); err == nil {
		t.Fatal("ambiguous duplicate refresh cookies were accepted")
	}
	h := NewHandler(&Service{now: func() time.Time { return now }}, HTTPOptions{})
	for i := 0; i < 21; i++ {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("192.0.2.%d", i))
		w := httptest.NewRecorder()
		if h.allowIP(w, r) != (i < 20) {
			t.Fatal("forwarded IP bypassed actual peer limit")
		}
	}
}
