package commerce

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"time"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

var (
	ErrGuestSession   = errors.New("guest session unavailable")
	ErrGuestCapacity  = errors.New("guest session capacity unavailable")
	ErrCartChoice     = errors.New("cart choice conflicts with current versions")
	ErrGuestCheckout  = errors.New("guest checkout unresolved")
	ErrAccountSession = errors.New("account session unavailable")
)

type GuestSession struct {
	GuestID   string    `json:"guest_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

func guestView(row db.GuestSession) GuestSession {
	return GuestSession{GuestID: row.GuestID.String(), ExpiresAt: row.ExpiresAt.Time.UTC()}
}

func GuestTokenDigest(raw string) ([]byte, error) {
	if len(raw) != 43 {
		return nil, ErrGuestSession
	}

	decoded, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil || len(decoded) != 32 {
		return nil, ErrGuestSession
	}

	hash := sha256.Sum256(decoded)
	return hash[:], nil
}

func NewGuestToken() (string, []byte, error) {
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", nil, err
	}

	raw := base64.RawURLEncoding.EncodeToString(secret[:])
	hash, err := GuestTokenDigest(raw)

	return raw, hash, err
}

// Locate without a row lock, then serialize on the immutable principal.
// Recheck the verifier and database clock after the wait; rotation/end use this order too.
func lockGuestSession(ctx context.Context, q *db.Queries, hash []byte, write bool) (db.GuestSession, error) {
	if len(hash) != 32 {
		return db.GuestSession{}, ErrGuestSession
	}

	located, err := q.FindGuestSession(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.GuestSession{}, ErrGuestSession
	}
	if err != nil {
		return db.GuestSession{}, err
	}

	if write {
		_, err = q.LockGuestPrincipal(ctx, located.GuestID)
	} else {
		_, err = q.ReadLockGuestPrincipal(ctx, located.GuestID)
	}
	if err != nil {
		return db.GuestSession{}, err
	}

	row, err := q.VerifyGuestSession(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.GuestSession{}, ErrGuestSession
	}

	return row, err
}

func lockOwnerCart(ctx context.Context, q *db.Queries, owner cartOwner, write bool) (db.Cart, error) {
	if owner.user.Valid {
		if write {
			return q.LockCart(ctx, owner.user)
		}
		return q.ReadLockCart(ctx, owner.user)
	}

	session, err := lockGuestSession(ctx, q, owner.guestHash, write)
	if err != nil {
		return db.Cart{}, err
	}

	var cart db.Cart
	if write {
		cart, err = q.LockGuestCart(ctx, session.GuestID)
	} else {
		cart, err = q.ReadLockGuestCart(ctx, session.GuestID)
	}
	if err != nil {
		return db.Cart{}, err
	}

	// Cart locks may have waited behind a different transaction.
	if _, err := q.VerifyGuestSession(ctx, owner.guestHash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.Cart{}, ErrGuestSession
		}
		return db.Cart{}, err
	}

	return cart, nil
}

func (s *Service) GetGuestSession(ctx context.Context, raw string) (GuestSession, error) {
	hash, err := GuestTokenDigest(raw)
	if err != nil {
		return GuestSession{}, err
	}

	return transact(ctx, s.pool, func(q *db.Queries) (GuestSession, error) {
		row, err := lockGuestSession(ctx, q, hash, false)
		if err != nil {
			return GuestSession{}, err
		}
		return guestView(row), nil
	})
}

func (s *Service) CreateGuestSession(ctx context.Context) (GuestSession, string, error) {
	raw, hash, err := NewGuestToken()
	if err != nil {
		return GuestSession{}, "", err
	}
	guest, err := newID()
	if err != nil {
		return GuestSession{}, "", err
	}
	cart, err := newID()
	if err != nil {
		return GuestSession{}, "", err
	}
	sid, err := newID()
	if err != nil {
		return GuestSession{}, "", err
	}

	view, err := transact(ctx, s.pool, func(q *db.Queries) (GuestSession, error) {
		if err := q.GuestCreationLock(ctx); err != nil {
			return GuestSession{}, err
		}
		count, err := q.CountLiveGuestSessions(ctx)
		if err != nil {
			return GuestSession{}, err
		}
		if count >= 10000 {
			return GuestSession{}, ErrGuestCapacity
		}
		if err := q.CreateGuestPrincipal(ctx, guest); err != nil {
			return GuestSession{}, err
		}
		if err := q.CreateGuestCart(ctx, db.CreateGuestCartParams{ID: cart, GuestID: guest}); err != nil {
			return GuestSession{}, err
		}
		row, err := q.CreateGuestSession(ctx, db.CreateGuestSessionParams{ID: sid, GuestID: guest, TokenHash: hash})
		if err != nil {
			return GuestSession{}, err
		}
		return guestView(row), nil
	})
	if err != nil {
		return GuestSession{}, "", err
	}

	return view, raw, nil
}

func (s *Service) RotateGuestSession(ctx context.Context, raw string) (GuestSession, string, error) {
	hash, err := GuestTokenDigest(raw)
	if err != nil {
		return GuestSession{}, "", err
	}

	next, nextHash, err := NewGuestToken()
	if err != nil {
		return GuestSession{}, "", err
	}

	id, err := newID()
	if err != nil {
		return GuestSession{}, "", err
	}

	view, err := transact(ctx, s.pool, func(q *db.Queries) (GuestSession, error) {
		old, err := lockGuestSession(ctx, q, hash, true)
		if err != nil {
			return GuestSession{}, err
		}
		if err := q.RevokeGuestSession(ctx, hash); err != nil {
			return GuestSession{}, err
		}
		row, err := q.RotateGuestSession(ctx, db.RotateGuestSessionParams{ID: id, GuestID: old.GuestID, TokenHash: nextHash, ExpiresAt: old.ExpiresAt})
		if err != nil {
			return GuestSession{}, err
		}
		return guestView(row), nil
	})
	if err != nil {
		return GuestSession{}, "", err
	}

	return view, next, nil
}

func (s *Service) EndGuestSession(ctx context.Context, raw string) error {
	hash, err := GuestTokenDigest(raw)
	if err != nil {
		return nil
	}

	_, err = transact(ctx, s.pool, func(q *db.Queries) (bool, error) {
		located, err := q.FindGuestSession(ctx, hash)
		if errors.Is(err, pgx.ErrNoRows) {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		if _, err := q.LockGuestPrincipal(ctx, located.GuestID); err != nil {
			return false, err
		}
		return true, q.RevokeGuestSession(ctx, hash)
	})

	return err
}

type CartChoiceInput struct {
	Choice             string `json:"choice"`
	GuestCartVersion   int64  `json:"guest_cart_version"`
	AccountCartVersion int64  `json:"account_cart_version"`
}

type CartChoiceStatus struct {
	Required           bool   `json:"required"`
	GuestCartVersion   int64  `json:"guest_cart_version"`
	AccountCartVersion int64  `json:"account_cart_version"`
	Choice             string `json:"choice,omitempty"`
}

type CartChoiceResult struct {
	Choice string `json:"choice"`
	Cart   Cart   `json:"cart"`
}

type choiceState struct {
	guest         db.GuestSession
	account, cart db.Cart
	sid           pgtype.UUID
	receipt       db.GuestCartChoice
	hasReceipt    bool
}

func lockChoice(ctx context.Context, q *db.Queries, userID, sessionID string, hash []byte) (choiceState, error) {
	var result choiceState
	user, err := parseID(userID)
	if err != nil {
		return result, ErrAccountSession
	}

	sid, err := parseID(sessionID)
	if err != nil {
		return result, ErrAccountSession
	}

	current, err := q.LockUser(ctx, user)
	if err != nil {
		return result, err
	}

	if !current.IsActive {
		return result, ErrAccountSession
	}

	result.sid = sid
	result.guest, err = lockGuestSession(ctx, q, hash, true)
	if err != nil {
		return result, err
	}

	if _, err := q.LockChoiceAccountSession(ctx, db.LockChoiceAccountSessionParams{SessionID: sid, UserID: user}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return result, ErrAccountSession
		}
		return result, err
	}

	carts, err := q.LockChoiceCarts(ctx, db.LockChoiceCartsParams{UserID: user, GuestID: result.guest.GuestID})
	if err != nil {
		return result, err
	}

	for _, cart := range carts {
		if cart.UserID == user {
			result.account = cart
		} else if cart.GuestID == result.guest.GuestID {
			result.cart = cart
		}
	}

	if len(carts) != 2 || !result.account.ID.Valid || !result.cart.ID.Valid {
		return result, errors.New("persistent choice carts unavailable")
	}

	if _, err := q.VerifyGuestSession(ctx, hash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return result, ErrGuestSession
		}
		return result, err
	}

	active, err := q.SessionIsActive(ctx, db.SessionIsActiveParams{SessionID: sid, UserID: user})
	if err != nil {
		return result, err
	}

	if !active {
		return result, ErrAccountSession
	}

	result.receipt, err = q.FindGuestCartChoice(ctx, db.FindGuestCartChoiceParams{SessionID: sid, GuestID: result.guest.GuestID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}

	result.hasReceipt = err == nil
	return result, nil
}

func (s *Service) GetGuestCartChoice(ctx context.Context, userID, sessionID, raw string) (CartChoiceStatus, error) {
	hash, err := GuestTokenDigest(raw)
	if err != nil {
		return CartChoiceStatus{}, err
	}

	return transact(ctx, s.pool, func(q *db.Queries) (CartChoiceStatus, error) {
		state, err := lockChoice(ctx, q, userID, sessionID, hash)
		if err != nil {
			return CartChoiceStatus{}, err
		}
		items, err := q.ListCartItems(ctx, state.cart.ID)
		if err != nil {
			return CartChoiceStatus{}, err
		}
		result := CartChoiceStatus{Required: len(items) > 0, GuestCartVersion: state.cart.Version, AccountCartVersion: state.account.Version}
		if state.hasReceipt && state.receipt.ResultingGuestVersion == state.cart.Version {
			result.Required = false
			result.Choice = state.receipt.Choice
		}
		return result, nil
	})
}

func (s *Service) ChooseGuestCart(ctx context.Context, userID, sessionID, raw string, input CartChoiceInput) (CartChoiceResult, error) {
	if (input.Choice != "keep_account" && input.Choice != "use_guest") || input.GuestCartVersion < 1 || input.GuestCartVersion > MaxCartVersion || input.AccountCartVersion < 1 || input.AccountCartVersion > MaxCartVersion {
		return CartChoiceResult{}, ErrInvalidInput
	}

	hash, err := GuestTokenDigest(raw)
	if err != nil {
		return CartChoiceResult{}, err
	}

	return transact(ctx, s.pool, func(q *db.Queries) (CartChoiceResult, error) {
		state, err := lockChoice(ctx, q, userID, sessionID, hash)
		if err != nil {
			return CartChoiceResult{}, err
		}
		old := state.receipt
		duplicate := state.hasReceipt && old.Choice == input.Choice && old.GuestVersion == input.GuestCartVersion && old.AccountVersion == input.AccountCartVersion && old.ResultingGuestVersion == state.cart.Version
		if !duplicate {
			// Keeping a cart leaves both versions unchanged. Do not let a losing
			// different choice overwrite that winner using the same version tuple.
			if state.hasReceipt && old.ResultingGuestVersion == state.cart.Version {
				return CartChoiceResult{}, ErrCartChoice
			}
			if state.cart.Version != input.GuestCartVersion || state.account.Version != input.AccountCartVersion {
				return CartChoiceResult{}, ErrCartChoice
			}
			if input.Choice == "use_guest" {
				prepared, err := q.GuestHasPreparedIntent(ctx, state.guest.GuestID)
				if err != nil {
					return CartChoiceResult{}, err
				}
				if prepared {
					return CartChoiceResult{}, ErrGuestCheckout
				}
				if state.cart.Version >= MaxCartVersion || state.account.Version >= MaxCartVersion {
					return CartChoiceResult{}, ErrVersionExhausted
				}
				items, err := q.ListCartItems(ctx, state.cart.ID)
				if err != nil {
					return CartChoiceResult{}, err
				}
				if len(items) > MaxCartItems {
					return CartChoiceResult{}, ErrCartFull
				}
				if err := q.ClearCart(ctx, state.account.ID); err != nil {
					return CartChoiceResult{}, err
				}
				for _, item := range items {
					if item.Quantity < 1 || int64(item.Quantity) > MaxQuantity {
						return CartChoiceResult{}, ErrInvalidInput
					}
					id, err := newID()
					if err != nil {
						return CartChoiceResult{}, err
					}
					if err := q.InsertCartItem(ctx, db.InsertCartItemParams{ID: id, CartID: state.account.ID, ProductID: item.ProductID, Quantity: item.Quantity}); err != nil {
						return CartChoiceResult{}, err
					}
				}
				if err := q.ClearCart(ctx, state.cart.ID); err != nil {
					return CartChoiceResult{}, err
				}
				state.account.Version, err = q.IncrementCartVersion(ctx, state.account.ID)
				if err != nil {
					return CartChoiceResult{}, err
				}
				state.cart.Version, err = q.IncrementCartVersion(ctx, state.cart.ID)
				if err != nil {
					return CartChoiceResult{}, err
				}
			}
			if err := q.SaveGuestCartChoice(ctx, db.SaveGuestCartChoiceParams{SessionID: state.sid, UserID: state.account.UserID, GuestID: state.guest.GuestID, Choice: input.Choice, GuestVersion: input.GuestCartVersion, AccountVersion: input.AccountCartVersion, ResultingGuestVersion: state.cart.Version, ResultingAccountVersion: state.account.Version}); err != nil {
				return CartChoiceResult{}, err
			}
		}
		items, err := q.ListCartItems(ctx, state.account.ID)
		if err != nil {
			return CartChoiceResult{}, err
		}
		return CartChoiceResult{Choice: input.Choice, Cart: cartView(state.account, items)}, nil
	})
}
