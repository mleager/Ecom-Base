package checkout

import (
	"context"
	"errors"

	"ecom/backend/internal/commerce"
	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

var errGuestRecovery = errors.New("guest recovery access unavailable")

type guestTarget struct {
	intent, order pgtype.UUID
}

type guestAccess struct {
	owner  pgtype.UUID
	digest []byte
	grant  guestTarget
}

func (a guestAccess) full() bool { return !a.grant.intent.Valid && !a.grant.order.Valid }

func recoveryAccess(row db.GuestRecoverySession, digest []byte) guestAccess {
	return guestAccess{owner: row.GuestID, digest: digest, grant: guestTarget{intent: row.IntentID, order: row.OrderID}}
}

// Authenticated scope and owner are derived from database credentials. A
// supplied ID selects a resource but grants no permission to read or mutate it.
func (s *GuestService) authorize(ctx context.Context, fullHash, recoveryHash []byte, target guestTarget, fullOnly bool) (guestAccess, error) {
	q := db.New(s.checkout.pool)
	var full, scoped guestAccess
	if len(fullHash) == 32 {
		session, err := q.VerifyGuestSession(ctx, fullHash)
		if err == nil {
			full = guestAccess{owner: session.GuestID, digest: fullHash}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return guestAccess{}, err
		}
	}
	if fullOnly {
		if full.owner.Valid {
			return full, nil
		}
		return guestAccess{}, commerce.ErrGuestSession
	}
	if len(recoveryHash) == 32 {
		row, err := q.VerifyGuestRecoverySession(ctx, recoveryHash)
		if err == nil {
			scoped = recoveryAccess(row, recoveryHash)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return guestAccess{}, err
		}
	}
	if !full.owner.Valid && !scoped.owner.Valid {
		if len(recoveryHash) == 32 {
			return guestAccess{}, errGuestRecovery
		}
		return guestAccess{}, commerce.ErrGuestSession
	}
	if target.intent.Valid {
		owner, err := q.GuestIntentOwner(ctx, target.intent)
		if errors.Is(err, pgx.ErrNoRows) && full.owner.Valid {
			// A full owner may fence a preparation that has not arrived yet.
			return full, nil
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return guestAccess{}, errGuestIntentNotFound
		}
		if err != nil {
			return guestAccess{}, err
		}
		if full.owner == owner {
			return full, nil
		}
		if scoped.owner == owner && scoped.grant.intent == target.intent {
			return scoped, nil
		}
		return guestAccess{}, errGuestIntentNotFound
	}
	if target.order.Valid {
		row, err := q.GuestOrderScope(ctx, target.order)
		if errors.Is(err, pgx.ErrNoRows) {
			return guestAccess{}, ErrOrderNotFound
		}
		if err != nil {
			return guestAccess{}, err
		}
		if full.owner == row.GuestID {
			return full, nil
		}
		if scoped.owner == row.GuestID && (scoped.grant.order == target.order || scoped.grant.intent == row.GuestIntentID) {
			return scoped, nil
		}
		return guestAccess{}, ErrOrderNotFound
	}
	return guestAccess{}, ErrIntegrity
}

func (a guestAccess) verify(ctx context.Context, q *db.Queries) error {
	if !a.owner.Valid || len(a.digest) != 32 {
		return commerce.ErrGuestSession
	}
	if a.full() {
		row, err := q.VerifyGuestSession(ctx, a.digest)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && row.GuestID != a.owner {
			return commerce.ErrGuestSession
		}
		return err
	}
	row, err := q.VerifyGuestRecoverySession(ctx, a.digest)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (row.GuestID != a.owner || row.IntentID != a.grant.intent || row.OrderID != a.grant.order) {
		return errGuestRecovery
	}
	return err
}

func (a guestAccess) lock(ctx context.Context, q *db.Queries) error {
	if _, err := q.LockGuestPrincipal(ctx, a.owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return commerce.ErrGuestSession
		}
		return err
	}
	if !a.full() {
		if _, err := q.ReadLockGuestRecoverySession(ctx, a.digest); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errGuestRecovery
			}
			return err
		}
	}
	return a.verify(ctx, q)
}
