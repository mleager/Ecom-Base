package auth

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
)

const refreshCookieName = "ecom_refresh"

type HTTPOptions struct {
	Origin        string
	SecureCookies bool
	Logger        *slog.Logger
}

type Handler struct {
	service              *Service
	options              HTTPOptions
	ipLimiter            *limiter
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
		ipLimiter:            newLimiter(20),
		emailLimiter:         newLimiter(5),
		securityIPLimiter:    newLimiter(20),
		securityUserLimiter:  newLimiter(5),
		securityTokenLimiter: newLimiter(5),
		resetAddressLimiter:  newWindowLimiter(3, time.Hour),
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
				api.Options("/*", h.preflight)
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
	if !decode(w, r, &input, "first_name", "last_name", "email", "password") || !h.allowEmail(w, input.Email) {
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
	if !decode(w, r, &input, "email", "password") || !h.allowEmail(w, input.Email) {
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

	raw, err := readRefreshCookie(r)
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

	raw, _ := readRefreshCookie(r)
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
			Name:     refreshCookieName,
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
	if !h.csrf(w, r) || !h.allowPeer(w, r, h.securityIPLimiter) {
		return
	}

	user, ok := Principal(r.Context())
	sid, sessionOK := r.Context().Value(sessionKey{}).(string)
	if !ok || !sessionOK {
		respondError(w, ErrUnauthorized)
		return
	}

	if !h.securityUserLimiter.allow(user.ID, h.service.now()) {
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
		h.mailFailure(w)
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) writeTokens(w http.ResponseWriter, tokens Tokens) {
	// Use the database's absolute deadline, without cross-clock Max-Age arithmetic.
	http.SetCookie(
		w, &http.Cookie{
			Name:     refreshCookieName,
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

func readRefreshCookie(r *http.Request) (string, error) {
	var found *http.Cookie
	for _, cookie := range r.Cookies() {
		if cookie.Name == refreshCookieName {
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
