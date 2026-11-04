package auth

import (
	"context"
	"encoding/hex"
	"errors"
	"math"

	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/email"

	"github.com/jackc/pgx/v5"
)

const PasswordResetRequestMessage = "If this address is eligible, recovery instructions will be sent."

type PasswordResetRequest struct {
	Email string `json:"email"`
}

type PasswordResetConfirmation struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

// RequestPasswordReset reports internal processing failures only to the handler.
// The public response never distinguishes eligibility, suppression or delivery.
func (s *Service) RequestPasswordReset(ctx context.Context, input PasswordResetRequest) error {
	input.Email = canonicalEmail(input.Email)
	if !validEmail(input.Email) {
		return ErrInvalidInput
	}

	if !s.mailer.Enabled() {
		return ErrMailDisabled
	}

	snapshot, err := s.queries.FindUserByEmail(ctx, input.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return ErrSecurityUnavailable
	}

	if !snapshot.IsActive || !snapshot.EmailVerifiedAt.Valid {
		return nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ErrSecurityUnavailable
	}
	// Public issuance has a four-second work budget. A cancelled pgx rollback
	// closes/discards a non-idle connection instead of extending that budget.
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.queries.WithTx(tx)
	current, err := q.LockUser(ctx, snapshot.ID)
	if err != nil {
		return ErrSecurityUnavailable
	}

	if !current.IsActive || !current.EmailVerifiedAt.Valid || current.Email != input.Email {
		return nil
	}

	if _, err := q.LockSecurityTokens(ctx, current.ID); err != nil {
		return ErrSecurityUnavailable
	}

	budget, err := q.PasswordResetIssueBudget(ctx, current.ID)
	if err != nil {
		return ErrSecurityUnavailable
	}

	if budget.Issued >= 3 || budget.Live >= 3 {
		return nil
	}

	raw, err := refreshToken()
	if err != nil {
		return ErrSecurityUnavailable
	}

	digest, err := tokenDigest(raw)
	if err != nil {
		return ErrSecurityUnavailable
	}

	hash, err := hex.DecodeString(digest)
	if err != nil {
		return ErrSecurityUnavailable
	}

	id, err := newID()
	if err != nil {
		return ErrSecurityUnavailable
	}

	if q.CreatePasswordResetToken(ctx, db.CreatePasswordResetTokenParams{ID: id, UserID: current.ID, TokenHash: hash, Email: current.Email, CredentialVersion: current.CredentialVersion}) != nil {
		return ErrSecurityUnavailable
	}

	if tx.Commit(ctx) != nil {
		return ErrSecurityOutcomeUnknown
	}

	valid, err := s.queries.PasswordResetDeliverable(ctx, id)
	if err != nil || !valid {
		return ErrSecurityUnavailable
	}

	if s.mailer.Send(ctx, []email.Message{{To: current.Email, Subject: "Reset your Commerce Lab password", Body: "You requested a Commerce Lab password reset. This link expires in 15 minutes and can be used once. Opening it alone does not change your password. Submit a different new password to reset it and sign out all existing sessions.\n\n" + s.mailOrigin + "/reset-password#token=" + raw + "\n\nIf you did not request this, ignore this message. Requesting another link does not invalidate earlier links; a successful reset invalidates all of them."}}) != nil {
		return email.ErrDelivery
	}

	return nil
}

func (s *Service) ConfirmPasswordReset(ctx context.Context, input PasswordResetConfirmation) (SecurityChangeResult, error) {
	digest, err := tokenDigest(input.Token)
	if err != nil {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}

	if !validPassword(input.NewPassword) {
		return SecurityChangeResult{}, ErrInvalidInput
	}

	verifier, _ := hex.DecodeString(digest)
	token, err := s.queries.FindPasswordResetToken(ctx, verifier)
	if errors.Is(err, pgx.ErrNoRows) {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if !token.Unexpired || token.ConsumedAt.Valid || token.InvalidatedAt.Valid {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}

	snapshot, err := s.queries.FindUserByID(ctx, token.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if !snapshot.IsActive || !snapshot.EmailVerifiedAt.Valid || snapshot.Email != token.Email || snapshot.CredentialVersion != token.CredentialVersion {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}

	same, _, err := s.passwords.verify(ctx, input.NewPassword, snapshot.PasswordHash)
	if errors.Is(err, ErrCapacity) {
		return SecurityChangeResult{}, err
	}
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if same {
		return SecurityChangeResult{}, ErrInvalidInput
	}

	hash, err := s.passwords.hash(ctx, input.NewPassword)
	if errors.Is(err, ErrCapacity) {
		return SecurityChangeResult{}, err
	}
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}
	defer rollbackSecurity(tx)

	q := s.queries.WithTx(tx)
	current, err := q.LockUser(ctx, snapshot.ID)
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if !current.IsActive || !current.EmailVerifiedAt.Valid || current.PasswordHash != snapshot.PasswordHash || current.CredentialVersion != snapshot.CredentialVersion || current.Email != snapshot.Email {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}

	if _, err := q.LockPendingEmailRequests(ctx, current.ID); err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if _, err := q.LockSecurityTokens(ctx, current.ID); err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if _, err := q.LockUserSessions(ctx, current.ID); err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	token, err = q.FindPasswordResetToken(ctx, verifier)
	if errors.Is(err, pgx.ErrNoRows) {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if token.UserID != current.ID || !token.Unexpired || token.Email != current.Email || token.CredentialVersion != current.CredentialVersion || token.ConsumedAt.Valid || token.InvalidatedAt.Valid {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}

	if current.CredentialVersion == math.MaxInt64 {
		return SecurityChangeResult{}, ErrCredentialVersion
	}

	changed, err := q.ConsumePasswordResetToken(ctx, db.ConsumePasswordResetTokenParams{ID: token.ID, UserID: current.ID})
	if err != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if changed != 1 {
		return SecurityChangeResult{}, ErrInvalidSecurityToken
	}

	changed, err = q.ReplacePassword(ctx, db.ReplacePasswordParams{ID: current.ID, PasswordHash: hash})
	if err != nil || changed != 1 {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if q.CancelPendingEmailRequests(ctx, current.ID) != nil || q.InvalidateSecurityTokens(ctx, current.ID) != nil || q.RevokeUserSessions(ctx, current.ID) != nil {
		return SecurityChangeResult{}, ErrSecurityUnavailable
	}

	if tx.Commit(ctx) != nil {
		return SecurityChangeResult{}, ErrSecurityOutcomeUnknown
	}

	result := SecurityChangeResult{ReauthenticationRequired: true, Notification: "unconfirmed"}
	if s.mailer.Send(ctx, []email.Message{{To: current.Email, Subject: "Commerce Lab password reset", Body: "Your Commerce Lab password was reset and all existing sessions were revoked. Sign in using your new password. If this was unexpected, your account credentials may be compromised. No password or recovery token is included in this notification."}}) == nil {
		result.Notification = "accepted"
	}

	return result, nil
}
