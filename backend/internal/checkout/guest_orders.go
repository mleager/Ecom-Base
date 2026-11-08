package checkout

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"ecom/backend/internal/commerce"
	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type guestCheckoutResult struct {
	result  Result
	refusal error
	contact string
}

func (s *GuestService) submit(ctx context.Context, access guestAccess, r validatedRequest) (Result, error) {
	t1, cancel := context.WithTimeout(ctx, 5*time.Second)
	created, err := s.createGuestPending(t1, access, r)
	cancel()

	switch {
	case errors.Is(err, ErrOutcomeUncertain):
		return s.resolveGuestCheckout(ctx, access, r, nil)
	case guestBusinessRefusal(err):
		return s.resolveGuestCheckout(ctx, access, r, err)
	case err != nil:
		return Result{}, err
	case created.refusal != nil:
		return Result{}, created.refusal
	case created.result.Replayed:
		return created.result, nil
	}

	orderID, err := parseID(created.result.Order.ID)
	if err != nil {
		return Result{}, ErrIntegrity
	}

	result, err := s.checkout.finishCheckout(ctx, db.LockOwnedOrderParams{ID: orderID, GuestID: access.owner}, created.result)

	s.sendGuestReceipt(ctx, created.contact, created.result.Order.ID)
	return result, err
}

func (s *GuestService) createGuestPending(ctx context.Context, access guestAccess, r validatedRequest) (guestCheckoutResult, error) {
	ids, err := newIdentities()
	if err != nil {
		return guestCheckoutResult{}, err
	}

	return stateTransaction(ctx, s.checkout.pool, func(q *db.Queries) (guestCheckoutResult, error) {
		if err := lockGuestKey(ctx, q, access, r); err != nil {
			return guestCheckoutResult{}, err
		}
		row, err := findGuestIntent(ctx, q, r)
		if err != nil {
			return guestCheckoutResult{}, err
		}
		result, proceed, err := inspectGuestCheckout(ctx, q, r, row)
		if !proceed || err != nil {
			return result, err
		}
		cart, err := q.LockGuestCart(ctx, access.owner)
		if err != nil {
			return guestCheckoutResult{}, err
		}
		if err := access.verify(ctx, q); err != nil {
			return guestCheckoutResult{}, err
		}
		row, err = expireGuestIntent(ctx, q, row)
		if err != nil {
			return guestCheckoutResult{}, err
		}
		if row.State == "expired" {
			return guestCheckoutResult{refusal: errGuestIntentExpired}, nil
		}
		if cart.ID != row.SourceCartID {
			return guestCheckoutResult{}, ErrIntegrity
		}
		lines, err := checkoutLines(ctx, q, cart, r.version)
		if err != nil {
			return guestCheckoutResult{}, err
		}
		var shipping ShippingAddress
		if err := json.Unmarshal(row.ShippingAddress, &shipping); err != nil {
			return guestCheckoutResult{}, ErrIntegrity
		}
		r.guestPayload, r.contactEmail = row.PayloadHash, row.ContactEmail
		result.result, err = writePending(ctx, q, r, ids, cart, lines, shipping)
		if err != nil {
			return guestCheckoutResult{}, err
		}
		if err := changedOne(q.CompleteGuestIntent(ctx, db.CompleteGuestIntentParams{ID: row.ID, GuestID: row.GuestID, OrderID: ids.order})); err != nil {
			return guestCheckoutResult{}, err
		}
		if err := access.verify(ctx, q); err != nil {
			return guestCheckoutResult{}, err
		}
		result.contact = row.ContactEmail.String
		return result, nil
	})
}

// Inspect the original key before consulting mutable cart state or expiry.
func inspectGuestCheckout(ctx context.Context, q *db.Queries, r validatedRequest, row db.GuestCheckoutIntent) (guestCheckoutResult, bool, error) {
	if row.CartVersion.Valid && (row.CartVersion.Int64 != r.version || row.PaymentScenario.String != r.scenario) {
		return guestCheckoutResult{}, false, ErrIdempotencyConflict
	}

	key, err := q.FindGuestCheckoutKey(ctx, db.FindGuestCheckoutKeyParams{GuestID: r.guest, IdempotencyKey: r.key})
	if err == nil {
		r.guestPayload = row.PayloadHash
		if row.State != "known_order" || key.OrderID != row.OrderID || key.RequestHash != r.fingerprint(row.SourceCartID) {
			return guestCheckoutResult{}, false, ErrIntegrity
		}
		order, err := loadOrder(ctx, q, db.CheckoutOrderParams{ID: row.OrderID, GuestID: r.guest})
		return guestCheckoutResult{result: Result{Order: order, Replayed: true}}, false, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return guestCheckoutResult{}, false, err
	}

	switch row.State {
	case "prepared":
		return guestCheckoutResult{}, true, nil
	case "expired":
		return guestCheckoutResult{refusal: errGuestIntentExpired}, false, nil
	case "retired":
		return guestCheckoutResult{refusal: errGuestIntentRetired}, false, nil
	case "rejected":
		return guestCheckoutResult{refusal: errGuestIntentRejected}, false, nil
	default:
		return guestCheckoutResult{}, false, ErrIntegrity
	}
}

func guestBusinessRefusal(err error) bool {
	return errors.Is(err, ErrStaleCart) || errors.Is(err, ErrVersionExhausted) || errors.Is(err, ErrEmptyCart) ||
		errors.Is(err, ErrInvalidTotal) || errors.Is(err, ErrProductUnavailable) || errors.Is(err, ErrInsufficientInventory)
}

// Partial T1 writes have rolled back. Reacquire the original fence before
// recording a rejection, and prefer any order that won the intervening race.
func (s *GuestService) resolveGuestCheckout(ctx context.Context, access guestAccess, r validatedRequest, refusal error) (Result, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()

	resolved, err := stateTransaction(ctx, s.checkout.pool, func(q *db.Queries) (guestCheckoutResult, error) {
		if err := lockGuestKey(ctx, q, access, r); err != nil {
			return guestCheckoutResult{}, err
		}
		row, err := findGuestIntent(ctx, q, r)
		if err != nil {
			return guestCheckoutResult{}, err
		}
		result, proceed, err := inspectGuestCheckout(ctx, q, r, row)
		if !proceed || err != nil {
			return result, err
		}
		if refusal == nil {
			return guestCheckoutResult{}, ErrOutcomeUncertain
		}
		if err := closeGuestIntent(ctx, q, row, "rejected"); err != nil {
			return guestCheckoutResult{}, err
		}
		return guestCheckoutResult{refusal: refusal}, nil
	})
	if err != nil {
		return Result{}, ErrOutcomeUncertain
	}
	return resolved.result, resolved.refusal
}

func (s *GuestService) order(ctx context.Context, access guestAccess, id pgtype.UUID) (Order, error) {
	q := db.New(s.checkout.pool)
	if err := access.verify(ctx, q); err != nil {
		return Order{}, err
	}

	return loadOrder(ctx, q, db.CheckoutOrderParams{ID: id, GuestID: access.owner})
}

func (s *GuestService) listOrders(ctx context.Context, access guestAccess, limit, offset int64) ([]Order, error) {
	if !access.full() {
		return nil, commerce.ErrGuestSession
	}

	tx, err := s.checkout.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)

	q := db.New(tx)
	if err := access.verify(ctx, q); err != nil {
		return nil, err
	}

	return readOrderPage(ctx, q, db.ListOwnedOrderIDsParams{GuestID: access.owner, PageLimit: limit, PageOffset: offset})
}

func (s *GuestService) cancelOrder(ctx context.Context, access guestAccess, id pgtype.UUID) (Order, error) {
	return s.checkout.cancelOrder(ctx, db.LockOwnedOrderParams{ID: id, GuestID: access.owner}, access.lock, access.verify)
}
