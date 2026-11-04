package auth

import (
	"context"
	"errors"
	"math"
	"time"

	"ecom/backend/internal/platform/email"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

var (
	ErrReauthentication       = errors.New("current password rejected")
	ErrCredentialsChanged     = errors.New("credentials changed during request")
	ErrCredentialVersion      = errors.New("credential version exhausted")
	ErrSecurityUnavailable    = errors.New("security operation unavailable")
	ErrSecurityOutcomeUnknown = errors.New("security commit outcome unknown")
)

type PasswordChange struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type SecurityChangeResult struct {
	ReauthenticationRequired bool   `json:"reauthentication_required"`
	Notification             string `json:"notification"`
}

// ChangePassword rechecks the server-authenticated session under the same user
// lock that serializes login/refresh. No caller-selected account/session is used.
func (s *Service) ChangePassword(ctx context.Context, userID, sessionID string, input PasswordChange) (SecurityChangeResult, error) {
	if !validPassword(input.CurrentPassword) || !validPassword(input.NewPassword) {
		return SecurityChangeResult{}, ErrInvalidInput
	}

	var uid, sid pgtype.UUID
	if uid.Scan(userID) != nil || sid.Scan(sessionID) != nil || !uid.Valid || !sid.Valid {
		return SecurityChangeResult{}, ErrUnauthorized
	}

	snapshot, err := s.queries.FindUserByID(ctx, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return SecurityChangeResult{}, ErrUnauthorized
	}
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	matched, _, err := s.passwords.verify(ctx, input.CurrentPassword, snapshot.PasswordHash)
	if err != nil {
		if errors.Is(err, ErrCapacity) {
			return SecurityChangeResult{}, err
		}
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if !matched {
		return SecurityChangeResult{}, ErrReauthentication
	}

	if input.CurrentPassword == input.NewPassword {
		return SecurityChangeResult{}, ErrInvalidInput
	}

	hash, err := s.passwords.hash(ctx, input.NewPassword)
	if err != nil {
		if errors.Is(err, ErrCapacity) {
			return SecurityChangeResult{}, err
		}
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()

	queries := s.queries.WithTx(tx)
	current, err := queries.LockUser(ctx, uid)
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if !current.IsActive {
		return SecurityChangeResult{}, ErrUnauthorized
	}

	if _, err := queries.LockPendingEmailRequests(ctx, uid); err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if _, err := queries.LockSecurityTokens(ctx, uid); err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if _, err := queries.LockUserSessions(ctx, uid); err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	active, err := queries.SessionIsActive(ctx, db.SessionIsActiveParams{SessionID: sid, UserID: uid})
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if !active {
		return SecurityChangeResult{}, ErrUnauthorized
	}

	if current.PasswordHash != snapshot.PasswordHash || current.CredentialVersion != snapshot.CredentialVersion {
		return SecurityChangeResult{}, ErrCredentialsChanged
	}

	if current.CredentialVersion == math.MaxInt64 {
		return SecurityChangeResult{}, ErrCredentialVersion
	}

	if queries.CancelPendingEmailRequests(ctx, uid) != nil || queries.InvalidateSecurityTokens(ctx, uid) != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	changed, err := queries.ReplacePassword(ctx, db.ReplacePasswordParams{ID: uid, PasswordHash: hash})
	if err != nil || changed != 1 {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if err := queries.RevokeUserSessions(ctx, uid); err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if err := tx.Commit(ctx); err != nil {
		return SecurityChangeResult{}, ErrSecurityOutcomeUnknown
	}

	result := SecurityChangeResult{
		ReauthenticationRequired: true,
		Notification:             "not_applicable",
	}

	if current.EmailVerifiedAt.Valid {
		result.Notification = "unconfirmed"
		if s.mailer.Send(ctx, []email.Message{{
			To: current.Email, Subject: "Commerce Lab password changed",
			Body: "Your Commerce Lab password was changed and all existing sessions were revoked. Sign in using your new password. If this was unexpected, your account credentials may be compromised. No password or recovery token is included in this notification.",
		}}) == nil {
			result.Notification = "accepted"
		}
	}

	return result, nil
}
