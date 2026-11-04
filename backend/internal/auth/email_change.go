package auth

import (
	"context"
	"encoding/hex"
	"errors"
	"math"

	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/email"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

var (
	ErrEmailVerificationRequired = errors.New("current email verification required")
	ErrPendingEmailChangeMissing = errors.New("pending email change not found")
)

type EmailChangeRequest struct {
	NewEmail        string `json:"new_email"`
	CurrentPassword string `json:"current_password"`
}

type EmailChangeCancellation struct {
	RequestID       string `json:"request_id"`
	CurrentPassword string `json:"current_password"`
}

// EmailChangeResult - HTTP encodes Pending as a 202 status object and Change as the 200 credential
// change result. Neither result contains tokens or session credentials.
type EmailChangeResult struct {
	Pending bool
	Change  SecurityChangeResult
}

func (s *Service) RequestEmailChange(ctx context.Context, userID, sessionID string, input EmailChangeRequest) (MailRequestResult, error) {
	input.NewEmail = canonicalEmail(input.NewEmail)
	if !validEmail(input.NewEmail) {
		return MailRequestResult{}, ErrInvalidInput
	}

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

	if !current.EmailVerifiedAt.Valid {
		return MailRequestResult{}, ErrEmailVerificationRequired
	}

	if input.NewEmail == current.Email {
		return MailRequestResult{}, ErrInvalidInput
	}

	if !s.mailer.Enabled() {
		return MailRequestResult{}, ErrMailDisabled
	}

	budget, err := q.EmailChangeIssueBudget(ctx, current.ID)
	if err != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	if budget.Issued >= 5 {
		return MailRequestResult{}, &SecurityMailLimitError{Seconds: 3600}
	}

	if budget.CoolingDown {
		return MailRequestResult{}, &SecurityMailLimitError{Seconds: 60}
	}

	if q.ExpirePendingEmailRequests(ctx, current.ID) != nil || q.CancelPendingEmailRequests(ctx, current.ID) != nil || q.InvalidateEmailChangeTokens(ctx, current.ID) != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	id, err := newID()
	if err != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	request, err := q.CreateEmailChangeRequest(ctx, db.CreateEmailChangeRequestParams{ID: id, UserID: current.ID, OldEmail: current.Email, NewEmail: input.NewEmail, CredentialVersion: current.CredentialVersion})
	if err != nil {
		return MailRequestResult{}, ErrSecurityUnavailable
	}

	var raw [2]string
	for i, purpose := range []string{"email_change_old", "email_change_new"} {
		raw[i], err = refreshToken()
		if err != nil {
			return MailRequestResult{}, ErrSecurityUnavailable
		}
		digest, err := tokenDigest(raw[i])
		if err != nil {
			return MailRequestResult{}, ErrSecurityUnavailable
		}
		hash, err := hex.DecodeString(digest)
		if err != nil {
			return MailRequestResult{}, ErrSecurityUnavailable
		}
		tokenID, err := newID()
		if err != nil {
			return MailRequestResult{}, ErrSecurityUnavailable
		}
		target := current.Email
		if purpose == "email_change_new" {
			target = input.NewEmail
		}
		if q.CreateEmailChangeToken(ctx, db.CreateEmailChangeTokenParams{ID: tokenID, UserID: current.ID, TokenHash: hash, Purpose: purpose, Email: target, CredentialVersion: current.CredentialVersion, ChangeRequestID: id, ExpiresAt: request.ExpiresAt}) != nil {
			return MailRequestResult{}, ErrSecurityUnavailable
		}
	}

	if tx.Commit(ctx) != nil {
		return MailRequestResult{}, ErrSecurityOutcomeUnknown
	}

	result := MailRequestResult{Delivery: "unconfirmed"}
	valid, err := s.queries.EmailChangeDeliverable(ctx, id)
	if err != nil || !valid {
		return result, nil
	}

	messages := []email.Message{
		{
			To:      current.Email,
			Subject: "Approve your Commerce Lab email change",
			Body:    "Approve replacing your current Commerce Lab email. Both the current and proposed mailboxes must confirm this request within 30 minutes. Sign in to the requesting account and enter your current password. Opening the link alone has no effect.\n\n" + s.mailOrigin + "/confirm-email-change#token=" + raw[0] + "\n\nIf you did not request this, do not approve it. Sign in directly to Account security to cancel the pending request.",
		},
		{
			To:      input.NewEmail,
			Subject: "Confirm your new Commerce Lab email",
			Body:    "Confirm this proposed Commerce Lab email. Both the current and proposed mailboxes must confirm the same request within 30 minutes. Sign in to the requesting account and enter your current password. Opening the link alone has no effect.\n\n" + s.mailOrigin + "/confirm-email-change#token=" + raw[1] + "\n\nIf you did not request this, ignore this message.",
		},
	}

	if s.mailer.Send(ctx, messages) == nil {
		result.Delivery = "accepted"
	}

	return result, nil
}

func (s *Service) CancelEmailChange(ctx context.Context, userID, sessionID string, input EmailChangeCancellation) error {
	var id pgtype.UUID
	if id.Scan(input.RequestID) != nil || !id.Valid {
		return ErrInvalidInput
	}

	snapshot, sid, err := s.securityProof(ctx, userID, sessionID, input.CurrentPassword)
	if err != nil {
		return err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ErrSecurityUnavailable
	}
	defer rollbackSecurity(tx)

	q := s.queries.WithTx(tx)
	current, err := lockSecurityAccount(ctx, q, snapshot, sid)
	if err != nil {
		return err
	}

	changed, err := q.FinishEmailChangeRequest(ctx, db.FinishEmailChangeRequestParams{ID: id, UserID: current.ID, State: "cancelled"})
	if err != nil {
		return ErrSecurityUnavailable
	}

	if changed != 1 {
		return ErrPendingEmailChangeMissing
	}

	if q.InvalidateEmailChangeRequestTokens(ctx, db.InvalidateEmailChangeRequestTokensParams{ChangeRequestID: id, UserID: current.ID}) != nil {
		return ErrSecurityUnavailable
	}

	if tx.Commit(ctx) != nil {
		return ErrSecurityOutcomeUnknown
	}

	return nil
}

func (s *Service) ConfirmEmailChange(ctx context.Context, userID, sessionID string, input VerificationConfirmation) (EmailChangeResult, error) {
	digest, err := tokenDigest(input.Token)
	if err != nil {
		return EmailChangeResult{}, ErrInvalidSecurityToken
	}

	hash, _ := hex.DecodeString(digest)
	snapshot, sid, err := s.securityProof(ctx, userID, sessionID, input.CurrentPassword)
	if err != nil {
		return EmailChangeResult{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EmailChangeResult{}, ErrSecurityUnavailable
	}
	defer rollbackSecurity(tx)

	q := s.queries.WithTx(tx)
	current, err := lockSecurityAccount(ctx, q, snapshot, sid)
	if err != nil {
		return EmailChangeResult{}, err
	}

	token, err := q.FindEmailChangeToken(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailChangeResult{}, ErrInvalidSecurityToken
	}
	if err != nil {
		return EmailChangeResult{}, ErrSecurityUnavailable
	}

	if token.UserID != current.ID || !token.ChangeRequestID.Valid || token.CredentialVersion != current.CredentialVersion || token.ConsumedAt.Valid || token.InvalidatedAt.Valid || !current.EmailVerifiedAt.Valid {
		return EmailChangeResult{}, ErrInvalidSecurityToken
	}

	request, err := q.FindEmailChangeRequest(ctx, db.FindEmailChangeRequestParams{ID: token.ChangeRequestID, UserID: current.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailChangeResult{}, ErrInvalidSecurityToken
	}
	if err != nil {
		return EmailChangeResult{}, ErrSecurityUnavailable
	}

	if request.State != "pending" || !request.Unexpired || request.OldEmail != current.Email || request.CredentialVersion != current.CredentialVersion {
		return EmailChangeResult{}, ErrInvalidSecurityToken
	}

	var second bool
	switch token.Purpose {
	case "email_change_old":
		if token.Email != request.OldEmail || request.OldConfirmedAt.Valid {
			return EmailChangeResult{}, ErrInvalidSecurityToken
		}
		second = request.NewConfirmedAt.Valid
	case "email_change_new":
		if token.Email != request.NewEmail || request.NewConfirmedAt.Valid {
			return EmailChangeResult{}, ErrInvalidSecurityToken
		}
		second = request.OldConfirmedAt.Valid
	default:
		return EmailChangeResult{}, ErrInvalidSecurityToken
	}

	if second && current.CredentialVersion == math.MaxInt64 {
		return EmailChangeResult{}, ErrCredentialVersion
	}

	changed, err := q.ConsumeEmailChangeToken(ctx, db.ConsumeEmailChangeTokenParams{ID: token.ID, UserID: current.ID})
	if err != nil {
		return EmailChangeResult{}, ErrSecurityUnavailable
	}

	if changed != 1 {
		return EmailChangeResult{}, ErrInvalidSecurityToken
	}

	if !second {
		switch token.Purpose {
		case "email_change_old":
			changed, err = q.RecordEmailChangeOldProof(ctx, db.RecordEmailChangeOldProofParams{ID: request.ID, UserID: current.ID})
		case "email_change_new":
			changed, err = q.RecordEmailChangeNewProof(ctx, db.RecordEmailChangeNewProofParams{ID: request.ID, UserID: current.ID})
		default:
			return EmailChangeResult{}, ErrInvalidSecurityToken
		}
		if err != nil {
			return EmailChangeResult{}, ErrSecurityUnavailable
		}
		if changed != 1 {
			return EmailChangeResult{}, ErrInvalidSecurityToken
		}
		if tx.Commit(ctx) != nil {
			return EmailChangeResult{}, ErrSecurityOutcomeUnknown
		}
		return EmailChangeResult{Pending: true}, nil
	}
	// PostgreSQL aborts a transaction after a uniqueness error. Isolate the
	// expected race in a savepoint so conflict termination can still commit.

	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return EmailChangeResult{}, ErrSecurityUnavailable
	}

	changed, replaceErr := q.WithTx(savepoint).ReplaceVerifiedEmail(ctx, db.ReplaceVerifiedEmailParams{ID: current.ID, Email: request.NewEmail, CredentialVersion: current.CredentialVersion})
	state := "completed"
	if replaceErr != nil {
		var pgError *pgconn.PgError
		duplicate := errors.As(replaceErr, &pgError) && pgError.Code == "23505" && pgError.ConstraintName == "users_email_key"
		if savepoint.Rollback(ctx) != nil || !duplicate {
			return EmailChangeResult{}, ErrSecurityUnavailable
		}
		state = "conflict"
	} else {
		if changed != 1 {
			return EmailChangeResult{}, ErrCredentialsChanged
		}
		if savepoint.Commit(ctx) != nil {
			return EmailChangeResult{}, ErrSecurityUnavailable
		}
	}

	changed, err = q.CompleteEmailChangeProofs(ctx, db.CompleteEmailChangeProofsParams{ID: request.ID, UserID: current.ID, State: state})
	if err != nil {
		return EmailChangeResult{}, ErrSecurityUnavailable
	}

	if changed != 1 {
		return EmailChangeResult{}, ErrInvalidSecurityToken
	}

	if state == "conflict" {
		if q.InvalidateEmailChangeRequestTokens(ctx, db.InvalidateEmailChangeRequestTokensParams{ChangeRequestID: request.ID, UserID: current.ID}) != nil {
			return EmailChangeResult{}, ErrSecurityUnavailable
		}
		if tx.Commit(ctx) != nil {
			return EmailChangeResult{}, ErrSecurityOutcomeUnknown
		}
		return EmailChangeResult{}, ErrConflict
	}

	if q.CancelPendingEmailRequests(ctx, current.ID) != nil || q.InvalidateSecurityTokens(ctx, current.ID) != nil || q.RevokeUserSessions(ctx, current.ID) != nil {
		return EmailChangeResult{}, ErrSecurityUnavailable
	}

	if tx.Commit(ctx) != nil {
		return EmailChangeResult{}, ErrSecurityOutcomeUnknown
	}

	result := EmailChangeResult{
		Change: SecurityChangeResult{
			ReauthenticationRequired: true,
			Notification:             "unconfirmed",
		},
	}

	const subject = "Commerce Lab email changed"
	const body = "Your Commerce Lab sign-in email was changed and all existing sessions were revoked. Sign in using your new email. If this was unexpected, your account credentials may be compromised. No password or recovery token is included in this notification."
	if s.mailer.Send(ctx, []email.Message{{To: request.OldEmail, Subject: subject, Body: body}, {To: request.NewEmail, Subject: subject, Body: body}}) == nil {
		result.Change.Notification = "accepted"
	}

	return result, nil
}
