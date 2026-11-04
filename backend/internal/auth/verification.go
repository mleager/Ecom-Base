package auth

import (
	"context"
	"encoding/hex"
	"errors"
	"time"

	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/email"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

var (
	ErrInvalidSecurityToken = errors.New("invalid security token")
	ErrMailDisabled         = errors.New("email delivery unavailable")
)

type SecurityMailLimitError struct {
	Seconds int
}

func (*SecurityMailLimitError) Error() string {
	return "security mail issuance throttled"
}

type VerificationRequest struct {
	CurrentPassword string `json:"current_password"`
}

type VerificationConfirmation struct {
	Token           string `json:"token"`
	CurrentPassword string `json:"current_password"`
}

type MailRequestResult struct {
	Delivery string `json:"delivery"`
}

type PendingEmailChange struct {
	ID           string    `json:"id"`
	NewEmail     string    `json:"new_email"`
	ExpiresAt    time.Time `json:"expires_at"`
	OldConfirmed bool      `json:"old_confirmed"`
	NewConfirmed bool      `json:"new_confirmed"`
}

type SecurityStatus struct {
	EmailDeliveryAvailable bool                `json:"email_delivery_available"`
	PendingEmailChange     *PendingEmailChange `json:"pending_email_change"`
}

func (s *Service) SecurityStatus(ctx context.Context, userID string) (SecurityStatus, error) {
	var id pgtype.UUID
	if id.Scan(userID) != nil || !id.Valid {
		return SecurityStatus{}, ErrUnauthorized
	}

	result := SecurityStatus{EmailDeliveryAvailable: s.mailer.Enabled()}
	row, err := s.queries.GetPendingEmailChange(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return result, ErrSecurityUnavailable
	}

	result.PendingEmailChange = &PendingEmailChange{
		ID:           idString(row.ID),
		NewEmail:     row.NewEmail,
		ExpiresAt:    row.ExpiresAt.Time.UTC(),
		OldConfirmed: row.OldConfirmed,
		NewConfirmed: row.NewConfirmed,
	}

	return result, nil
}

func (s *Service) securityProof(ctx context.Context, userID, sessionID, password string) (db.User, pgtype.UUID, error) {
	var uid, sid pgtype.UUID
	if uid.Scan(userID) != nil || sid.Scan(sessionID) != nil || !uid.Valid || !sid.Valid {
		return db.User{}, sid, ErrUnauthorized
	}

	if !validPassword(password) {
		return db.User{}, sid, ErrInvalidInput
	}

	user, err := s.queries.FindUserByID(ctx, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return user, sid, ErrUnauthorized
	}
	if err != nil {
		return user, sid, ErrSecurityUnavailable
	}

	if !user.IsActive {
		return user, sid, ErrUnauthorized
	}

	matched, _, err := s.passwords.verify(ctx, password, user.PasswordHash)
	if errors.Is(err, ErrCapacity) {
		return user, sid, err
	}
	if err != nil {
		return user, sid, ErrSecurityUnavailable
	}

	if !matched {
		return user, sid, ErrReauthentication
	}

	return user, sid, nil
}

func rollbackSecurity(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}

func lockSecurityAccount(ctx context.Context, q *db.Queries, snapshot db.User, sid pgtype.UUID) (db.User, error) {
	user, err := q.LockUser(ctx, snapshot.ID)
	if err != nil {
		return user, ErrSecurityUnavailable
	}

	if !user.IsActive {
		return user, ErrUnauthorized
	}

	if _, err = q.LockPendingEmailRequests(ctx, user.ID); err != nil {
		return user, ErrSecurityUnavailable
	}

	if _, err = q.LockSecurityTokens(ctx, user.ID); err != nil {
		return user, ErrSecurityUnavailable
	}

	if _, err = q.LockUserSessions(ctx, user.ID); err != nil {
		return user, ErrSecurityUnavailable
	}

	active, err := q.SessionIsActive(ctx, db.SessionIsActiveParams{UserID: user.ID, SessionID: sid})
	if err != nil {
		return user, ErrSecurityUnavailable
	}

	if !active {
		return user, ErrUnauthorized
	}

	if user.PasswordHash != snapshot.PasswordHash || user.CredentialVersion != snapshot.CredentialVersion || user.Email != snapshot.Email {
		return user, ErrCredentialsChanged
	}

	return user, nil
}

func (s *Service) RequestVerification(ctx context.Context, userID, sessionID string, input VerificationRequest) (MailRequestResult, error) {
	snapshot, sid, err := s.securityProof(ctx, userID, sessionID, input.CurrentPassword)
	if err != nil {
		return MailRequestResult{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}
	defer rollbackSecurity(tx)

	q := s.queries.WithTx(tx)
	current, err := lockSecurityAccount(ctx, q, snapshot, sid)
	if err != nil {
		return MailRequestResult{}, err
	}

	if current.EmailVerifiedAt.Valid {
		return MailRequestResult{Delivery: "not_required"}, nil
	}

	if !s.mailer.Enabled() {
		return MailRequestResult{}, ErrMailDisabled
	}

	budget, err := q.VerificationIssueBudget(ctx, current.ID)
	if err != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	if budget.Issued >= 5 {
		return MailRequestResult{}, &SecurityMailLimitError{Seconds: 3600}
	}

	if budget.CoolingDown {
		return MailRequestResult{}, &SecurityMailLimitError{Seconds: 60}
	}

	raw, err := refreshToken()
	if err != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	digest, _ := tokenDigest(raw)
	hash, err := hex.DecodeString(digest)
	if err != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	id, err := newID()
	if err != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	if q.InvalidateVerificationTokens(ctx, current.ID) != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	if q.CreateVerificationToken(ctx, db.CreateVerificationTokenParams{ID: id, UserID: current.ID, TokenHash: hash, Email: current.Email, CredentialVersion: current.CredentialVersion}) != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	if tx.Commit(ctx) != nil {
		return MailRequestResult{}, ErrSecurityOutcomeUnknown
	}

	result := MailRequestResult{Delivery: "unconfirmed"}
	valid, err := s.queries.VerificationDeliverable(ctx, id)
	if err != nil || !valid {
		return result, nil
	}

	message := email.Message{
		To:      current.Email,
		Subject: "Verify your Commerce Lab email",
		Body:    "Confirm this email for your Commerce Lab account. The link expires in 30 minutes. Sign in to the requesting account and enter your current password.\n\n" + s.mailOrigin + "/verify-email#token=" + raw + "\n\nIf you did not request this, ignore this message. Opening the link alone does not verify an account.",
	}

	if s.mailer.Send(ctx, []email.Message{message}) == nil {
		result.Delivery = "accepted"
	}

	return result, nil
}

func (s *Service) ConfirmVerification(ctx context.Context, userID, sessionID string, input VerificationConfirmation) (User, error) {
	digest, err := tokenDigest(input.Token)
	if err != nil {
		return User{}, ErrInvalidSecurityToken
	}

	hash, _ := hex.DecodeString(digest)
	snapshot, sid, err := s.securityProof(ctx, userID, sessionID, input.CurrentPassword)
	if err != nil {
		return User{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, ErrSecurityUnavailable
	}
	defer rollbackSecurity(tx)

	q := s.queries.WithTx(tx)
	current, err := lockSecurityAccount(ctx, q, snapshot, sid)
	if err != nil {
		return User{}, err
	}

	token, err := q.FindVerificationToken(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrInvalidSecurityToken
	}
	if err != nil {
		return User{}, ErrSecurityUnavailable
	}

	if token.UserID != current.ID || token.Email != current.Email || token.CredentialVersion != current.CredentialVersion || current.EmailVerifiedAt.Valid || token.ConsumedAt.Valid || token.InvalidatedAt.Valid {
		return User{}, ErrInvalidSecurityToken
	}

	changed, err := q.ConsumeVerificationToken(ctx, db.ConsumeVerificationTokenParams{ID: token.ID, UserID: current.ID})
	if err != nil {
		return User{}, ErrSecurityUnavailable
	}

	if changed != 1 {
		return User{}, ErrInvalidSecurityToken
	}

	if q.MarkEmailVerified(ctx, current.ID) != nil {
		return User{}, ErrSecurityUnavailable
	}

	current, err = q.FindUserByID(ctx, current.ID)
	if err != nil {
		return User{}, ErrSecurityUnavailable
	}

	if tx.Commit(ctx) != nil {
		return User{}, ErrSecurityOutcomeUnknown
	}

	return userView(current), nil
}
