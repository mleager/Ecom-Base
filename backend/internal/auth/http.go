package auth

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"ecom/backend/internal/platform/clientip"
	"ecom/backend/internal/platform/metrics"
)

const refreshCookieBase = "ecom_refresh"

// CookieName names a credential cookie. With Secure cookies (HTTPS) the name
// carries the __Secure- prefix, which browsers accept only from a secure origin
// with the Secure attribute. Cookies are scoped by host, not port, so without
// the prefix a cookie left by a plain-HTTP stack on the same host (for example
// http://localhost:8080 beside https://localhost:8443) would be sent to the
// HTTPS server and read as a stale credential, and a Secure cookie would block
// the HTTP stack from setting its own.
func CookieName(base string, secure bool) string {
	if secure {
		return "__Secure-" + base
	}
	return base
}

type HTTPOptions struct {
	Origin        string
	SecureCookies bool
	Logger        *slog.Logger
	// Metrics counts rate-limit rejections (and guest sessions in commerce).
	// Nil counts nothing.
	Metrics *metrics.Recorder
	// ClientIP picks the address that per-IP limits key on. The zero value
	// uses the TCP peer.
	ClientIP clientip.Source
	// SharedLimits, when set, keeps every request limiter's counters in
	// PostgreSQL so several API tasks enforce one limit. Nil keeps them in
	// this process.
	SharedLimits *SharedLimits
}

type Handler struct {
	service              *Service
	options              HTTPOptions
	ipLimiter            *limiter
	ipSiteLimiter        *limiter
	emailLimiter         *limiter
	securityIPLimiter    *limiter
	securityUserLimiter  *limiter
	securityTokenLimiter *limiter
	resetAddressLimiter  *limiter
	resetSlots           chan struct{}
	authenticated        atomic.Uint64
}

func NewHandler(service *Service, options HTTPOptions) *Handler {
	return &Handler{
		service:              service,
		options:              options,
		ipLimiter:            newLimiter("auth_ip", 20, options.Metrics, options.SharedLimits),
		ipSiteLimiter:        newLimiter("auth_ip_site", 80, options.Metrics, options.SharedLimits),
		emailLimiter:         newLimiter("auth_email", 5, options.Metrics, options.SharedLimits),
		securityIPLimiter:    newLimiter("security_ip", 20, options.Metrics, options.SharedLimits),
		securityUserLimiter:  newLimiter("security_user", 5, options.Metrics, options.SharedLimits),
		securityTokenLimiter: newLimiter("security_token", 5, options.Metrics, options.SharedLimits),
		resetAddressLimiter:  newWindowLimiter("password_reset_address", 3, time.Hour, options.Metrics, options.SharedLimits),
		resetSlots:           make(chan struct{}, 32),
	}
}

func (h *Handler) Routes(router chi.Router) {
	h.RoutesWith()(router)
}

// RoutesWith mounts feature routes inside the same origin/CORS policy as auth.
func (h *Handler) RoutesWith(features ...func(chi.Router)) func(chi.Router) {
	return func(router chi.Router) {
		router.Group(func(r chi.Router) {
			r.Use(h.cors)
			r.Route("/api/v1", func(api chi.Router) {
				api.Use(h.answerPreflight)
				api.Post("/auth/register", h.register)
				api.Post("/auth/login", h.login)
				api.Post("/auth/refresh", h.refresh)
				api.Post("/auth/logout", h.logout)
				api.Post("/auth/password-resets", h.requestPasswordReset)
				api.Post("/auth/password-resets/confirm", h.confirmPasswordReset)
				api.With(h.Authenticate).Get("/users/me", h.me)
				api.With(h.Authenticate).Post("/users/me/password", h.changePassword)
				api.With(h.Authenticate).Get("/users/me/security", h.securityStatus)
				api.With(h.Authenticate).Post("/users/me/email-verification", h.requestVerification)
				api.With(h.Authenticate).Post("/users/me/email-verification/confirm", h.confirmVerification)
				api.With(h.Authenticate).Post("/users/me/email-change", h.requestEmailChange)
				api.With(h.Authenticate).Post("/users/me/email-change/confirm", h.confirmEmailChange)
				api.With(h.Authenticate).Post("/users/me/email-change/cancel", h.cancelEmailChange)
				for _, feature := range features {
					feature(api)
				}
			})
			r.With(h.Authenticate, RequireAdmin).Get("/metrics", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
				_, _ = fmt.Fprintf(w, "# HELP ecom_authenticated_requests_total Requests passing authentication in this process.\n# TYPE ecom_authenticated_requests_total counter\necom_authenticated_requests_total %d\n", h.authenticated.Load())
			})
		})
	}
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	if !h.allowIP(w, r) {
		return
	}

	var input Registration
	if !decode(w, r, &input, "first_name", "last_name", "email", "password") || !h.allowEmail(w, r, input.Email) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	user, err := h.service.Register(ctx, input)
	if err != nil {
		respondError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, user)
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) || !h.allowIP(w, r) {
		return
	}

	var input Credentials
	if !decode(w, r, &input, "email", "password") || !h.allowEmail(w, r, input.Email) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	tokens, err := h.service.Login(ctx, input)
	if err != nil {
		respondError(w, err)
		return
	}

	h.writeTokens(w, tokens)
}

func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}

	raw, err := readRefreshCookie(r, h.refreshCookie())
	if err != nil {
		respondError(w, ErrUnauthorized)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	tokens, err := h.service.Refresh(ctx, raw)
	if err != nil {
		// Do not clear the winner's cookie when a concurrent refresh loses.
		respondError(w, err)
		return
	}

	h.writeTokens(w, tokens)
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) {
		return
	}

	raw, _ := readRefreshCookie(r, h.refreshCookie())
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if err := h.service.Logout(ctx, raw); err != nil {
		respondError(w, err)
		return
	}

	h.clearRefreshCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) clearRefreshCookie(w http.ResponseWriter) {
	http.SetCookie(
		w, &http.Cookie{
			Name:     h.refreshCookie(),
			Path:     "/api/v1/auth",
			HttpOnly: true,
			Secure:   h.options.SecureCookies,
			SameSite: http.SameSiteStrictMode,
			MaxAge:   -1,
			Expires:  time.Unix(1, 0).UTC(),
		},
	)
}

func (h *Handler) changePassword(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) || !h.allowPeer(w, r, h.securityIPLimiter, nil) {
		return
	}

	user, ok := Principal(r.Context())
	sid, sessionOK := r.Context().Value(sessionKey{}).(string)
	if !ok || !sessionOK {
		respondError(w, ErrUnauthorized)
		return
	}

	if !h.securityUserLimiter.allow(r.Context(), user.ID, h.service.now()) {
		rateLimited(w)
		return
	}

	var input PasswordChange
	if !decode(w, r, &input, "current_password", "new_password") {
		return
	}

	result, err := h.service.ChangePassword(r.Context(), user.ID, sid, input)
	if err != nil {
		respondError(w, err)
		return
	}

	h.clearRefreshCookie(w)

	if result.Notification == "unconfirmed" {
		h.mailFailure(w, r)
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) writeTokens(w http.ResponseWriter, tokens Tokens) {
	// Use the database's absolute deadline, without cross-clock Max-Age arithmetic.
	http.SetCookie(
		w, &http.Cookie{
			Name:     h.refreshCookie(),
			Value:    tokens.Refresh,
			Path:     "/api/v1/auth",
			HttpOnly: true,
			Secure:   h.options.SecureCookies,
			SameSite: http.SameSiteStrictMode,
			Expires:  tokens.ExpiresAt.UTC().Truncate(time.Second),
		},
	)

	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, http.StatusOK, tokens)
}

func (h *Handler) refreshCookie() string {
	return CookieName(refreshCookieBase, h.options.SecureCookies)
}

func readRefreshCookie(r *http.Request, name string) (string, error) {
	var found *http.Cookie
	for _, cookie := range r.Cookies() {
		if cookie.Name == name {
			if found != nil {
				return "", ErrUnauthorized
			}
			found = cookie
		}
	}

	if found == nil {
		return "", ErrUnauthorized
	}

	if _, err := tokenDigest(found.Value); err != nil {
		return "", ErrUnauthorized
	}

	return found.Value, nil
}
