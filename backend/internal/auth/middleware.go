package auth

import (
	"context"
	"net/http"
	"strings"
	"time"
)

type principalKey struct{}
type sessionKey struct{}

// Principal is populated only after signature and current database-session checks.
func Principal(ctx context.Context) (User, bool) {
	user, ok := ctx.Value(principalKey{}).(User)
	return user, ok
}

// SessionID is available only after Authenticate verified the current session.
func SessionID(ctx context.Context) (string, bool) {
	sid, ok := ctx.Value(sessionKey{}).(string)
	return sid, ok
}

func (h *Handler) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values := r.Header.Values("Authorization")
		if len(values) != 1 || len(values[0]) > 4103 {
			respondError(w, ErrUnauthorized)
			return
		}

		parts := strings.Split(values[0], " ")
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
			respondError(w, ErrUnauthorized)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		user, sid, err := h.service.authenticateSession(ctx, parts[1])
		if err != nil {
			respondError(w, err)
			return
		}

		h.authenticated.Add(1)

		ctx = context.WithValue(ctx, principalKey{}, user)
		ctx = context.WithValue(ctx, sessionKey{}, sid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, exists := Principal(r.Context())
		if !exists {
			respondError(w, ErrUnauthorized)
			return
		}

		if user.Role != "admin" {
			writeError(w, http.StatusForbidden, "forbidden", "Administrator access required")
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	user, ok := Principal(r.Context())
	if !ok {
		respondError(w, ErrUnauthorized)
		return
	}

	writeJSON(w, http.StatusOK, user)
}

func (h *Handler) csrf(w http.ResponseWriter, r *http.Request) bool {
	if len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != h.options.Origin || len(r.Header.Values("X-CSRF-Protection")) != 1 || r.Header.Get("X-CSRF-Protection") != "1" {
		writeError(w, http.StatusForbidden, "csrf_rejected", "Origin and CSRF protection are required")
		return false
	}

	return true
}

func (h *Handler) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Add("Vary", "Origin")

		origin := r.Header.Get("Origin")
		if len(r.Header.Values("Origin")) > 1 || (origin != "" && origin != h.options.Origin) {
			writeError(w, http.StatusForbidden, "origin_rejected", "Origin is not allowed")
			return
		}

		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID, Retry-After")
		}

		next.ServeHTTP(w, r)
	})
}

func (h *Handler) preflight(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Vary", "Access-Control-Request-Method")
	w.Header().Add("Vary", "Access-Control-Request-Headers")

	if r.Header.Get("Origin") != h.options.Origin {
		writeError(w, http.StatusForbidden, "origin_rejected", "Origin is not allowed")
		return
	}

	method := r.Header.Get("Access-Control-Request-Method")
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodPatch && method != http.MethodDelete {
		writeError(w, http.StatusForbidden, "cors_rejected", "Method is not allowed")
		return
	}

	for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
		header = strings.ToLower(strings.TrimSpace(header))
		if header != "" && header != "content-type" && header != "authorization" && header != "x-csrf-protection" && header != "idempotency-key" {
			writeError(w, http.StatusForbidden, "cors_rejected", "Header is not allowed")
			return
		}
	}

	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Protection, Idempotency-Key")
	w.Header().Set("Access-Control-Max-Age", "300")
	w.WriteHeader(http.StatusNoContent)
}
