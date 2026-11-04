package checkout

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/commerce"
	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/email"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

var errGuestProof = errors.New("invalid guest mailbox proof")

type guestRecoveryView struct {
	GuestID   string    `json:"guest_id"`
	Scope     string    `json:"scope"`
	TargetID  string    `json:"target_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

func viewGuestRecovery(row db.GuestRecoverySession) guestRecoveryView {
	scope, target := "order", row.OrderID
	if row.IntentID.Valid {
		scope, target = "checkout_intent", row.IntentID
	}
	return guestRecoveryView{row.GuestID.String(), scope, target.String(), row.ExpiresAt.Time}
}

func recoveryTarget(ctx context.Context, q *db.Queries, target guestTarget) (pgtype.UUID, []byte, error) {
	switch {
	case target.intent.Valid && !target.order.Valid:
		owner, err := q.GuestIntentOwner(ctx, target.intent)
		if err != nil {
			return pgtype.UUID{}, nil, err
		}
		row, err := q.GuestIntentByID(ctx, db.GuestIntentByIDParams{ID: target.intent, GuestID: owner})
		return owner, row.ContactDigest, err
	case target.order.Valid && !target.intent.Valid:
		row, err := q.GuestOrderScope(ctx, target.order)
		digest := sha256.Sum256([]byte(row.ContactEmail.String))
		return row.GuestID, digest[:], err
	default:
		return pgtype.UUID{}, nil, ErrInvalidInput
	}
}

func (s *GuestService) deliveryEnabled() bool {
	return s.mailer != nil && s.mailer.Enabled() && s.origin != ""
}

// Delivery follows a confirmed proof commit. Callers deliberately collapse
// missing targets, ineligible requests and delivery failures into one receipt.
func (s *GuestService) issueGuestProof(ctx context.Context, target guestTarget, contact string) (string, error) {
	contact, valid := auth.NormalizeContactEmail(contact)
	if !valid {
		return "", ErrInvalidInput
	}
	digest := sha256.Sum256([]byte(contact))
	token, verifier, err := commerce.NewGuestToken()
	if err != nil {
		return "", err
	}
	id, err := newID()
	if err != nil {
		return "", err
	}
	return stateTransaction(ctx, s.checkout.pool, func(q *db.Queries) (string, error) {
		owner, expected, err := recoveryTarget(ctx, q, target)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		if subtle.ConstantTimeCompare(digest[:], expected) != 1 {
			return "", nil
		}
		if _, err := q.LockGuestPrincipal(ctx, owner); err != nil {
			return "", err
		}
		count, err := q.CountLiveGuestProofs(ctx, db.CountLiveGuestProofsParams{IntentID: target.intent, OrderID: target.order})
		if err != nil || count >= 3 {
			return "", err
		}
		err = q.InsertGuestProof(ctx, db.InsertGuestProofParams{
			ID: id, GuestID: owner, IntentID: target.intent, OrderID: target.order, EmailDigest: digest[:], TokenHash: verifier,
		})
		return token, err
	})
}

func (s *GuestService) sendGuestProof(ctx context.Context, contact, token string) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_ = s.mailer.Send(ctx, []email.Message{{
		To: contact, Subject: "Recover your Commerce Lab guest purchase",
		Body: "Use this single-use link within 15 minutes to recover access to your requested guest purchase.\n\n" +
			s.origin + "/guest/recover#token=" + token + "\n\nIf you did not request this link, you can ignore this email.",
	}})
}

func (s *GuestService) sendGuestReceipt(ctx context.Context, contact, orderID string) {
	if !s.deliveryEnabled() {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_ = s.mailer.Send(ctx, []email.Message{{
		To: contact, Subject: "Your Commerce Lab guest order reference",
		Body: "Your guest order was recorded. Check the order for its current simulated payment status.\n\n" +
			"Order reference: " + orderID + "\n" + s.origin + "/guest/orders/" + orderID,
	}})
}

func (s *GuestService) confirmGuestProof(ctx context.Context, digest, previous []byte) (guestRecoveryView, string, error) {
	if len(digest) != 32 {
		return guestRecoveryView{}, "", errGuestProof
	}
	raw, verifier, err := commerce.NewGuestToken()
	if err != nil {
		return guestRecoveryView{}, "", err
	}
	id, err := newID()
	if err != nil {
		return guestRecoveryView{}, "", err
	}
	row, err := stateTransaction(ctx, s.checkout.pool, func(q *db.Queries) (db.GuestRecoverySession, error) {
		proof, err := q.FindGuestProof(ctx, digest)
		if errors.Is(err, pgx.ErrNoRows) {
			return db.GuestRecoverySession{}, errGuestProof
		}
		if err != nil {
			return db.GuestRecoverySession{}, err
		}
		if _, err := q.LockGuestPrincipal(ctx, proof.GuestID); err != nil {
			return db.GuestRecoverySession{}, err
		}
		owner, emailDigest, err := recoveryTarget(ctx, q, guestTarget{intent: proof.IntentID, order: proof.OrderID})
		if errors.Is(err, pgx.ErrNoRows) {
			return db.GuestRecoverySession{}, errGuestProof
		}
		if err != nil {
			return db.GuestRecoverySession{}, err
		}
		if owner != proof.GuestID || subtle.ConstantTimeCompare(proof.EmailDigest, emailDigest) != 1 {
			return db.GuestRecoverySession{}, errGuestProof
		}
		changed, err := q.ConsumeGuestProof(ctx, proof.ID)
		if err != nil {
			return db.GuestRecoverySession{}, err
		}
		if changed != 1 {
			return db.GuestRecoverySession{}, errGuestProof
		}
		if len(previous) == 32 {
			if err := q.RevokeGuestRecoverySession(ctx, previous); err != nil {
				return db.GuestRecoverySession{}, err
			}
		}
		return q.InsertGuestRecoverySession(ctx, db.InsertGuestRecoverySessionParams{
			ID: id, GuestID: owner, IntentID: proof.IntentID, OrderID: proof.OrderID, TokenHash: verifier,
		})
	})
	if err != nil {
		return guestRecoveryView{}, "", err
	}
	return viewGuestRecovery(row), raw, nil
}

func (s *GuestService) getRecovery(ctx context.Context, digest []byte) (guestRecoveryView, error) {
	if len(digest) != 32 {
		return guestRecoveryView{}, errGuestRecovery
	}
	row, err := db.New(s.checkout.pool).VerifyGuestRecoverySession(ctx, digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return guestRecoveryView{}, errGuestRecovery
	}
	if err != nil {
		return guestRecoveryView{}, err
	}
	return viewGuestRecovery(row), nil
}

func (s *GuestService) endRecovery(ctx context.Context, digest []byte) error {
	if len(digest) != 32 {
		return nil
	}
	_, err := stateTransaction(ctx, s.checkout.pool, func(q *db.Queries) (struct{}, error) {
		return struct{}{}, q.RevokeGuestRecoverySession(ctx, digest)
	})
	return err
}
