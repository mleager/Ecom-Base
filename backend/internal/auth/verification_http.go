package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
)

func (h *Handler) mailFailure(w http.ResponseWriter, r *http.Request) {
	if h.options.Logger != nil {
		h.options.Logger.WarnContext(r.Context(), "security email delivery unconfirmed", "request_id", w.Header().Get("X-Request-ID"))
	}
}

func (h *Handler) securityActor(w http.ResponseWriter, r *http.Request) (User, string, bool) {
	if !h.csrf(w, r) || !h.allowPeer(w, r, h.securityIPLimiter, nil) {
		return User{}, "", false
	}

	user, ok := Principal(r.Context())
	sid, sessionOK := r.Context().Value(sessionKey{}).(string)

	if !ok || !sessionOK {
		respondError(w, ErrUnauthorized)
		return User{}, "", false
	}

	if !h.securityUserLimiter.allow(r.Context(), user.ID, h.service.now()) {
		rateLimited(w)
		return User{}, "", false
	}

	return user, sid, true
}

func (h *Handler) securityStatus(w http.ResponseWriter, r *http.Request) {
	user, ok := Principal(r.Context())
	if !ok {
		respondError(w, ErrUnauthorized)
		return
	}

	result, err := h.service.SecurityStatus(r.Context(), user.ID)
	if err != nil {
		respondError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) requestVerification(w http.ResponseWriter, r *http.Request) {
	user, sid, ok := h.securityActor(w, r)
	if !ok {
		return
	}

	var input VerificationRequest
	if !decode(w, r, &input, "current_password") {
		return
	}

	result, err := h.service.RequestVerification(r.Context(), user.ID, sid, input)
	if err != nil {
		respondError(w, err)
		return
	}

	if result.Delivery == "unconfirmed" {
		h.mailFailure(w, r)
	}

	writeJSON(w, http.StatusAccepted, result)
}

func (h *Handler) confirmVerification(w http.ResponseWriter, r *http.Request) {
	user, sid, ok := h.securityActor(w, r)
	if !ok {
		return
	}

	var input VerificationConfirmation
	if !decode(w, r, &input, "token", "current_password") {
		return
	}

	hash := sha256.Sum256([]byte(input.Token))
	if !h.securityTokenLimiter.allow(r.Context(), hex.EncodeToString(hash[:]), h.service.now()) {
		rateLimited(w)
		return
	}

	result, err := h.service.ConfirmVerification(r.Context(), user.ID, sid, input)
	if err != nil {
		respondError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}
