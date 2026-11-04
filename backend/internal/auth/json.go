package auth

import (
	"errors"
	"net/http"
	"strconv"

	"ecom/backend/internal/platform/httpjson"
)

func decode(w http.ResponseWriter, r *http.Request, destination any, required ...string) bool {
	return httpjson.Decode(w, r, destination, required, required)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	httpjson.Write(w, status, value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	httpjson.Error(w, status, code, message)
}

func respondError(w http.ResponseWriter, err error) {
	var limit *SecurityMailLimitError
	switch {
	case errors.As(err, &limit):
		w.Header().Set("Retry-After", strconv.Itoa(limit.Seconds))
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Security email requests are temporarily limited")
	case errors.Is(err, ErrEmailVerificationRequired):
		writeError(w, http.StatusConflict, "email_verification_required", "Verify your current email before requesting a change")
	case errors.Is(err, ErrPendingEmailChangeMissing):
		writeError(w, http.StatusNotFound, "not_found", "The pending email change was not found")
	case errors.Is(err, ErrInvalidSecurityToken):
		writeError(w, http.StatusBadRequest, "invalid_security_token", "The security link is invalid or no longer usable")
	case errors.Is(err, ErrMailDisabled):
		writeError(w, http.StatusServiceUnavailable, "email_delivery_unavailable", "Email delivery is not configured")
	case errors.Is(err, ErrInvalidInput):
		writeError(w, http.StatusUnprocessableEntity, "invalid_input", "Input does not meet the documented requirements")
	case errors.Is(err, ErrReauthentication):
		writeError(w, http.StatusForbidden, "reauthentication_failed", "Current password is incorrect")
	case errors.Is(err, ErrCredentialsChanged):
		writeError(w, http.StatusConflict, "credentials_changed", "Credentials changed; sign in again before making changes")
	case errors.Is(err, ErrCredentialVersion):
		writeError(w, http.StatusConflict, "credential_version_exhausted", "Credentials cannot be changed; contact the operator")
	case errors.Is(err, ErrSecurityUnavailable):
		writeError(w, http.StatusServiceUnavailable, "security_unavailable", "Security operation is unavailable")
	case errors.Is(err, ErrSecurityOutcomeUnknown):
		writeError(w, http.StatusServiceUnavailable, "security_outcome_unknown", "The change may have completed; sign in deliberately to check")
	case errors.Is(err, ErrUnauthorized):
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required")
	case errors.Is(err, ErrConflict):
		writeError(w, http.StatusConflict, "email_conflict", "An account with this email already exists")
	case errors.Is(err, ErrCapacity):
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusTooManyRequests, "auth_capacity", "Authentication capacity exceeded; retry later")
	default:
		// Unknown database/transport errors must fail closed without disclosing SQL.
		writeError(w, http.StatusInternalServerError, "internal_error", "Request could not be processed")
	}
}
