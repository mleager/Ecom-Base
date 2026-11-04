package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
)

func (h *Handler) requestEmailChange(w http.ResponseWriter, r *http.Request) {
	user, sid, ok := h.securityActor(w, r)
	if !ok {
		return
	}

	var input EmailChangeRequest
	if !decode(w, r, &input, "new_email", "current_password") {
		return
	}

	result, err := h.service.RequestEmailChange(r.Context(), user.ID, sid, input)
	if err != nil {
		respondError(w, err)
		return
	}

	if result.Delivery == "unconfirmed" {
		h.mailFailure(w)
	}

	writeJSON(w, http.StatusAccepted, result)
}

func (h *Handler) cancelEmailChange(w http.ResponseWriter, r *http.Request) {
	user, sid, ok := h.securityActor(w, r)
	if !ok {
		return
	}

	var input EmailChangeCancellation
	if !decode(w, r, &input, "request_id", "current_password") {
		return
	}

	if err := h.service.CancelEmailChange(r.Context(), user.ID, sid, input); err != nil {
		respondError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) confirmEmailChange(w http.ResponseWriter, r *http.Request) {
	user, sid, ok := h.securityActor(w, r)
	if !ok {
		return
	}

	var input VerificationConfirmation
	if !decode(w, r, &input, "token", "current_password") {
		return
	}

	hash := sha256.Sum256([]byte(input.Token))
	if !h.securityTokenLimiter.allow(hex.EncodeToString(hash[:]), h.service.now()) {
		rateLimited(w)
		return
	}

	result, err := h.service.ConfirmEmailChange(r.Context(), user.ID, sid, input)
	if err != nil {
		respondError(w, err)
		return
	}

	if result.Pending {
		writeJSON(w, http.StatusAccepted, struct {
			Status string `json:"status"`
		}{Status: "pending"})
		return
	}

	if result.Change.Notification == "unconfirmed" {
		h.mailFailure(w)
	}

	h.clearRefreshCookie(w)
	writeJSON(w, http.StatusOK, result.Change)
}
