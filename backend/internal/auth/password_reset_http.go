package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"time"
)

func (h *Handler) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) || !h.allowPeer(w, r, h.securityIPLimiter, nil) {
		return
	}
	var input PasswordResetRequest
	if !decode(w, r, &input, "email") {
		return
	}
	input.Email = canonicalEmail(input.Email)
	if !validEmail(input.Email) {
		respondError(w, ErrInvalidInput)
		return
	}
	if !h.service.mailer.Enabled() {
		respondError(w, ErrMailDisabled)
		return
	}
	select {
	case h.resetSlots <- struct{}{}:
		defer func() { <-h.resetSlots }()
	default:
		w.Header().Set("Retry-After", "5")
		respondError(w, ErrSecurityUnavailable)
		return
	}
	admitted := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	digest := sha256.Sum256([]byte(input.Email))
	if h.resetAddressLimiter.allow(r.Context(), hex.EncodeToString(digest[:]), h.service.now()) {
		work, stop := context.WithTimeout(ctx, 4*time.Second)
		err := h.service.RequestPasswordReset(work, input)
		stop()
		if err != nil {
			h.mailFailure(w, r)
		}
	}
	// Eligibility, persistence, suppression and delivery share the same response
	// window. Waiting is cancellable and retains the bounded admission slot.
	timer := time.NewTimer(time.Until(admitted.Add(5 * time.Second)))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
		writeJSON(w, http.StatusAccepted, struct {
			Message string `json:"message"`
		}{PasswordResetRequestMessage})
	}
}

func (h *Handler) confirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	if !h.csrf(w, r) || !h.allowPeer(w, r, h.securityIPLimiter, nil) {
		return
	}
	var input PasswordResetConfirmation
	if !decode(w, r, &input, "token", "new_password") {
		return
	}
	digest := sha256.Sum256([]byte(input.Token))
	if !h.securityTokenLimiter.allow(r.Context(), hex.EncodeToString(digest[:]), h.service.now()) {
		rateLimited(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, err := h.service.ConfirmPasswordReset(ctx, input)
	if err != nil {
		respondError(w, err)
		return
	}
	if result.Notification == "unconfirmed" {
		h.mailFailure(w, r)
	}
	// Public recovery neither reads nor changes the caller's refresh cookie.
	writeJSON(w, http.StatusOK, result)
}
