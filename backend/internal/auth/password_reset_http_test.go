package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ecom/backend/internal/platform/email"
)

type resetMail struct{}

func (resetMail) Enabled() bool                               { return true }
func (resetMail) Send(context.Context, []email.Message) error { return nil }

func TestPasswordResetGlobalAdmissionAndCancellation(t *testing.T) {
	h := NewHandler(&Service{now: time.Now, mailer: resetMail{}}, HTTPOptions{Origin: "http://localhost:5173"})
	// Suppress processing without replacing production time or database code.
	digest := sha256.Sum256([]byte("owned@example.test"))
	for range 3 {
		h.resetAddressLimiter.allow(hex.EncodeToString(digest[:]), time.Now())
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{}, 32)
	for i := range 32 {
		go func(i int) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(`{"email":"owned@example.test"}`)).WithContext(ctx)
			// Admission is independent of identity; use distinct peers for IP limits.
			r.RemoteAddr = fmt.Sprintf("127.0.0.%d:1234", i+1)
			r.Header.Set("Origin", h.options.Origin)
			r.Header.Set("X-CSRF-Protection", "1")
			r.Header.Set("Content-Type", "application/json")
			h.requestPasswordReset(httptest.NewRecorder(), r)
			done <- struct{}{}
		}(i)
	}
	deadline := time.Now().Add(time.Second)
	for len(h.resetSlots) != 32 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(h.resetSlots) != 32 {
		t.Fatal("global admission slots were not retained through padding")
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{"email":"other@example.test"}`))
	r.RemoteAddr = "127.0.0.99:1234"
	r.Header.Set("Origin", h.options.Origin)
	r.Header.Set("X-CSRF-Protection", "1")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.requestPasswordReset(w, r)
	if w.Code != 503 || w.Header().Get("Retry-After") != "5" {
		t.Fatal("global saturation did not reject before lookup")
	}
	cancel()
	for range 32 {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("cancelled admission did not finish")
		}
	}
	if len(h.resetSlots) != 0 {
		t.Fatal("cancelled requests leaked admission slots")
	}
	if len(h.resetAddressLimiter.entries) != 1 {
		t.Fatal("saturated request reached address lookup")
	}
	if _, ok := h.resetAddressLimiter.entries["owned@example.test"]; ok {
		t.Fatal("limiter retained a raw address")
	}
}

func TestSuppressedResetUsesRealResponseWindow(t *testing.T) {
	h := NewHandler(&Service{now: time.Now, mailer: resetMail{}}, HTTPOptions{Origin: "http://localhost:5173"})
	digest := sha256.Sum256([]byte("owned@example.test"))
	for range 3 {
		h.resetAddressLimiter.allow(hex.EncodeToString(digest[:]), time.Now())
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{"email":"  OWNED@example.test  "}`))
	r.Header.Set("Origin", h.options.Origin)
	r.Header.Set("X-CSRF-Protection", "1")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	started := time.Now()
	h.requestPasswordReset(w, r)
	if time.Since(started) < 5*time.Second || time.Since(started) > 6*time.Second || w.Code != 202 || w.Body.String() != "{\"message\":\""+PasswordResetRequestMessage+"\"}\n" || len(w.Result().Cookies()) != 0 {
		t.Fatal("suppression changed public timing, response or cookies")
	}
}
