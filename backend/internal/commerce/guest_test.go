package commerce

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"ecom/backend/internal/auth"

	"github.com/go-chi/chi/v5"
)

func TestGuestSecretsAndCookies(t *testing.T) {
	raw, hash, err := NewGuestToken()
	if err != nil || len(raw) != 43 || len(hash) != 32 {
		t.Fatal("secret generation failed")
	}
	other, otherHash, err := NewGuestToken()
	if err != nil || raw == other || bytes.Equal(hash, otherHash) {
		t.Fatal("secrets reused")
	}
	for _, invalid := range []string{"", raw + "=", strings.Repeat("a", 42), strings.Repeat("a", 44), strings.Repeat("/", 43), base64.RawURLEncoding.EncodeToString(make([]byte, 31))} {
		if _, err := GuestTokenDigest(invalid); err == nil {
			t.Fatal("invalid credential accepted")
		}
	}
	for _, secure := range []bool{false, true} {
		h := NewGuestHandler(nil, nil, auth.HTTPOptions{SecureCookies: secure})
		w := httptest.NewRecorder()
		deadline := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
		h.cookie(w, raw, deadline)
		cookies := w.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatal("cookie missing")
		}
		c := cookies[0]
		if c.Name != "ecom_guest" || c.Value != raw || !c.HttpOnly || c.Secure != secure || c.Domain != "" || c.Path != "/api/v1/guest" || c.SameSite != http.SameSiteStrictMode || !c.Expires.Equal(deadline) {
			t.Fatal("cookie policy differs")
		}
	}
}

func TestGuestAdmission(t *testing.T) {
	const origin = "http://localhost:5173"
	for _, tc := range []struct {
		name, method, path, body, cookie, bearer, origin, csrf string
		status                                                 int
	}{
		{"missing csrf", "POST", "/guest/session", "", "", "", origin, "", 403},
		{"missing origin", "POST", "/guest/session", "", "", "", "", "1", 403},
		{"foreign origin", "GET", "/guest/session", "", "", "", "https://other.test", "", 403},
		{"unexpected bearer", "GET", "/guest/cart", "", "", "Bearer a", origin, "", 400},
		{"duplicate cookies", "POST", "/guest/session", "", "ecom_guest=x; ecom_guest=y", "", origin, "1", 401},
		{"empty supplied credential", "POST", "/guest/session", "", "ecom_guest=", "", origin, "1", 401},
		{"malformed supplied credential", "POST", "/guest/session", "", `ecom_guest="bad\\value"`, "", origin, "1", 401},
		{"body on bootstrap", "POST", "/guest/session", "{}", "", "", origin, "1", 400},
		{"oversize body", "POST", "/guest/session", strings.Repeat(" ", 65537), "", "", origin, "1", 413},
		{"unknown body field", "POST", "/guest/cart/items", `{"product_id":"a","quantity":1,"owner_id":"b"}`, "", "", origin, "1", 400},
		{"duplicate body field", "PATCH", "/guest/cart/items/id", `{"quantity":1,"quantity":2}`, "", "", origin, "1", 400},
		{"null body field", "PATCH", "/guest/cart/items/id", `{"quantity":null}`, "", "", origin, "1", 400},
		{"query", "GET", "/guest/session?other=1", "", "", "", origin, "", 400},
		{"missing cookie", "GET", "/guest/cart", "", "", "", origin, "", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewGuestHandler(nil, func(next http.Handler) http.Handler { return next }, auth.HTTPOptions{Origin: origin})
			router := chi.NewRouter()
			h.Routes(router)
			r := httptest.NewRequest(tc.method, "/api/v1"+tc.path, strings.NewReader(tc.body))
			r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api/v1")
			r.RemoteAddr = "127.0.0.1:1234"
			r.Header.Set("Content-Type", "application/json")
			if tc.cookie != "" {
				r.Header.Set("Cookie", tc.cookie)
			}
			if tc.bearer != "" {
				r.Header.Set("Authorization", tc.bearer)
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if tc.csrf != "" {
				r.Header.Set("X-CSRF-Protection", tc.csrf)
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status %d, expected %d", w.Code, tc.status)
			}
		})
	}
}

func TestGuestAdmissionBudgets(t *testing.T) {
	const origin = "http://localhost:5173"
	for _, kind := range []string{"reads", "bootstrap", "slots", "capacity"} {
		t.Run(kind, func(t *testing.T) {
			h := NewGuestHandler(nil, func(next http.Handler) http.Handler { return next }, auth.HTTPOptions{Origin: origin})
			r := httptest.NewRequest("POST", "/guest/session", nil)
			r.RemoteAddr = "127.0.0.1:1000"
			r.Header.Set("Origin", origin)
			r.Header.Set("X-CSRF-Protection", "1")
			want := 429
			switch kind {
			case "reads":
				for range 120 {
					h.reads.Check("127.0.0.1", time.Now())
				}
				r.Method = "GET"
			case "bootstrap":
				for range 5 {
					h.bootstrap.Check("127.0.0.1", time.Now())
				}
			case "slots":
				for range 32 {
					h.slots <- struct{}{}
				}
				want = 503
			case "capacity":
				for i := range 10000 {
					h.bootstrap.Check(strconv.Itoa(i), time.Now())
				}
				want = 503
			default:
				t.Fatal("unknown admission test")
			}
			router := chi.NewRouter()
			h.Routes(router)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			seconds, err := strconv.Atoi(w.Header().Get("Retry-After"))
			if w.Code != want || err != nil || seconds < 1 || seconds > 3600 {
				t.Fatal("admission budget/status/retry header differs")
			}
		})
	}
}
