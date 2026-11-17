//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/clientip"

	"github.com/go-chi/chi/v5"
)

// Review L10 and M5 (M17 task 7): failed sign-ins count per email and client
// and per email, successful ones never count, and registration attempts
// count per email and client. Run with process-local and shared counters.
func TestSignInAndRegistrationLimits(t *testing.T) {
	f := newTestDatabase(t)
	service, err := auth.NewService(f.pool, []byte(strings.Repeat("limits-test-key-", 2)), time.Now)
	if err != nil {
		t.Fatal(err)
	}

	for _, store := range []string{"memory", "postgres"} {
		t.Run(store, func(t *testing.T) {
			var shared *auth.SharedLimits
			if store == "postgres" {
				shared = auth.NewSharedLimits(f.pool, nil)
			}
			router := chi.NewRouter()
			auth.NewHandler(service, auth.HTTPOptions{Origin: authTestOrigin, ClientIP: clientip.CloudFront, SharedLimits: shared}).Routes(router)
			send := func(path, body, client string) int {
				r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Origin", authTestOrigin)
				r.Header.Set("X-CSRF-Protection", "1")
				r.Header.Set(clientip.ViewerAddressHeader, client+":443")
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r.WithContext(context.Background()))
				return w.Code
			}
			signIn := func(email, password, client string) int {
				return send("/api/v1/auth/login", credentialsBody(email, password), client)
			}
			// Each client is its own /48, so the IP limits stay out of the way.
			client := func(n int) string { return fmt.Sprintf("2001:db8:%x::1", 0xa0+n) }

			email := store + "-owner@example.com"
			if _, err := service.Register(f.ctx, auth.Registration{FirstName: "Test", LastName: "Owner", Email: email, Password: authTestPassword}); err != nil {
				t.Fatal(err)
			}

			// Successful sign-ins never use the budget.
			for i := range 8 {
				if code := signIn(email, authTestPassword, client(0)); code != 200 {
					t.Fatalf("successful sign-in %d: status %d", i+1, code)
				}
			}

			// A stranger's failures lock out only the stranger's client.
			for i := range 5 {
				if code := signIn(email, "a wrong but valid passphrase", client(1)); code != 401 {
					t.Fatalf("failure %d: status %d, want 401", i+1, code)
				}
			}
			if code := signIn(email, "a wrong but valid passphrase", client(1)); code != 429 {
				t.Fatalf("sixth failure from one client: status %d, want 429", code)
			}
			if code := signIn(email, authTestPassword, client(1)); code != 429 {
				t.Fatalf("the right password from the locked client: status %d, want 429", code)
			}
			if code := signIn(email, authTestPassword, client(0)); code != 200 {
				t.Fatalf("the owner's client: status %d, want 200", code)
			}

			// Failures from all clients together are capped at 20 a minute.
			for c := 2; c <= 4; c++ {
				for range 5 {
					if code := signIn(email, "a wrong but valid passphrase", client(c)); code != 401 {
						t.Fatalf("client %d: status %d, want 401", c, code)
					}
				}
			}
			if code := signIn(email, authTestPassword, client(5)); code != 429 {
				t.Fatalf("after 20 failures from 4 clients: status %d, want 429", code)
			}
			// Another email is unaffected.
			if code := signIn(store+"-other@example.com", "a wrong but valid passphrase", client(5)); code != 401 {
				t.Fatalf("another email: status %d, want 401", code)
			}

			// Registration counts every attempt per email and client.
			fresh := store + "-signup@example.com"
			for i := range 5 {
				want := 409
				if i == 0 {
					want = 201
				}
				if code := send("/api/v1/auth/register", registrationBody(fresh), client(6)); code != want {
					t.Fatalf("registration %d: status %d, want %d", i+1, code, want)
				}
			}
			if code := send("/api/v1/auth/register", registrationBody(fresh), client(6)); code != 429 {
				t.Fatalf("sixth registration from one client: status %d, want 429", code)
			}
			if code := send("/api/v1/auth/register", registrationBody(fresh), client(7)); code != 409 {
				t.Fatalf("registration from another client: status %d, want 409", code)
			}
		})
	}
}
