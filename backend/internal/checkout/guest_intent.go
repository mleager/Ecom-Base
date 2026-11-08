package checkout

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/commerce"
	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/email"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

var (
	errGuestIntentNotFound = errors.New("guest checkout intent not found")
	errGuestIntentExpired  = errors.New("guest checkout intent expired")
	errGuestIntentRetired  = errors.New("guest checkout intent retired")
	errGuestIntentRejected = errors.New("guest checkout intent rejected")
	errGuestIntentCapacity = errors.New("guest checkout intent capacity exhausted")
)

type GuestService struct {
	checkout *Service
	mailer   email.Sender
	origin   string
}

func NewGuestService(checkout *Service, mailer email.Sender, origin string) *GuestService {
	return &GuestService{
		checkout: checkout,
		mailer:   mailer,
		origin:   origin,
	}
}

type GuestReference struct {
	IntentID        string `json:"checkout_intent_id"`
	CartVersion     int64  `json:"cart_version"`
	PaymentScenario string `json:"payment_scenario"`
}

type guestPreparation struct {
	ID              string          `json:"id"`
	CartVersion     int64           `json:"cart_version"`
	PaymentScenario string          `json:"payment_scenario"`
	ContactEmail    string          `json:"contact_email"`
	Shipping        json.RawMessage `json:"shipping_address"`
}

type guestIntentView struct {
	ID             string           `json:"id"`
	GuestID        string           `json:"guest_id"`
	State          string           `json:"state"`
	IdempotencyKey string           `json:"idempotency_key,omitempty"`
	Request        *GuestReference  `json:"request,omitempty"`
	ContactEmail   string           `json:"contact_email,omitempty"`
	Shipping       *ShippingAddress `json:"shipping_address,omitempty"`
	CreatedAt      *time.Time       `json:"created_at,omitempty"`
	ExpiresAt      *time.Time       `json:"expires_at,omitempty"`
	OrderID        string           `json:"order_id,omitempty"`
}

func viewGuestIntent(row db.GuestCheckoutIntent) (guestIntentView, error) {
	view := guestIntentView{ID: row.ID.String(), GuestID: row.GuestID.String(), State: row.State}
	switch row.State {
	case "prepared":
		var shipping ShippingAddress
		if err := json.Unmarshal(row.ShippingAddress, &shipping); err != nil {
			return guestIntentView{}, ErrIntegrity
		}
		view.Request = &GuestReference{row.ID.String(), row.CartVersion.Int64, row.PaymentScenario.String}
		view.IdempotencyKey = row.IdempotencyKey.String()
		view.ContactEmail = row.ContactEmail.String
		view.Shipping = &shipping
		view.CreatedAt, view.ExpiresAt = &row.CreatedAt.Time, &row.ExpiresAt.Time
	case "known_order":
		view.OrderID = row.OrderID.String()
	case "retired", "expired", "rejected":
	default:
		return guestIntentView{}, ErrIntegrity
	}

	return view, nil
}

func parseV4(raw string) (pgtype.UUID, error) {
	id, err := parseID(raw)
	if err != nil || id.String() != raw || id.Bytes[6]>>4 != 4 || id.Bytes[8]>>6 != 2 {
		return pgtype.UUID{}, ErrMalformedID
	}

	return id, nil
}

func guestRequest(owner pgtype.UUID, key string, ref GuestReference) (validatedRequest, error) {
	if _, err := parseV4(key); err != nil {
		return validatedRequest{}, ErrInvalidKey
	}

	id, err := parseV4(ref.IntentID)
	if err != nil {
		return validatedRequest{}, err
	}

	if ref.CartVersion < 1 || ref.CartVersion > commerce.MaxCartVersion || ref.PaymentScenario != "accept" && ref.PaymentScenario != "reject" {
		return validatedRequest{}, ErrInvalidInput
	}

	return validatedRequest{
		guest:       owner,
		guestIntent: id,
		key:         key,
		version:     ref.CartVersion,
		scenario:    ref.PaymentScenario,
	}, nil
}

func guestKey(r validatedRequest) pgtype.UUID {
	key, _ := parseV4(r.key)
	return key
}

func normalizeGuestShipping(input ShippingAddress) (ShippingAddress, error) {
	if input.CountryCode != "US" || input.Label != "" {
		return ShippingAddress{}, ErrInvalidInput
	}

	address, err := commerce.NormalizeShippingAddress(commerce.Address{
		RecipientName: input.RecipientName, Line1: input.Line1, Line2: input.Line2,
		City: input.City, Region: input.Region, PostalCode: input.PostalCode, CountryCode: input.CountryCode,
	})
	if err != nil {
		return ShippingAddress{}, ErrInvalidInput
	}

	return ShippingAddress{
		RecipientName: address.RecipientName,
		Line1:         address.Line1,
		Line2:         address.Line2,
		City:          address.City,
		Region:        address.Region,
		PostalCode:    address.PostalCode,
		CountryCode:   address.CountryCode,
	}, nil
}

func (s *GuestService) prepare(ctx context.Context, access guestAccess, r validatedRequest, address ShippingAddress, contact string) (guestIntentView, bool, error) {
	if !access.full() || access.owner != r.guest {
		return guestIntentView{}, false, commerce.ErrGuestSession
	}

	contact, valid := auth.NormalizeContactEmail(contact)
	if !valid {
		return guestIntentView{}, false, ErrInvalidInput
	}

	address, err := normalizeGuestShipping(address)
	if err != nil {
		return guestIntentView{}, false, err
	}

	shipping, err := json.Marshal(address)
	if err != nil {
		return guestIntentView{}, false, err
	}

	payload, _ := json.Marshal(struct {
		Contact  string
		Shipping ShippingAddress
	}{contact, address})

	hash := sha256.Sum256(payload)
	contactHash := sha256.Sum256([]byte(contact))

	type preparationResult struct {
		intent  guestIntentView
		created bool
	}

	result, err := stateTransaction(ctx, s.checkout.pool, func(q *db.Queries) (preparationResult, error) {
		var result preparationResult
		if err := lockGuestKey(ctx, q, access, r); err != nil {
			return result, err
		}
		if err := q.ExpireGuestIntents(ctx, access.owner); err != nil {
			return result, err
		}
		row, err := q.LockGuestIntentByKey(ctx, db.LockGuestIntentByKeyParams{GuestID: access.owner, IdempotencyKey: guestKey(r)})
		if err == nil {
			if row.ID != r.guestIntent || row.CartVersion.Int64 != r.version || row.PaymentScenario.String != r.scenario || !bytes.Equal(row.PayloadHash, hash[:]) {
				return result, ErrIdempotencyConflict
			}
			result.intent, err = viewGuestIntent(row)
			return result, err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return result, err
		}
		if err := ensureGuestIntentCapacity(ctx, q, access.owner); err != nil {
			return result, err
		}
		cart, err := q.LockGuestCart(ctx, access.owner)
		if err != nil {
			return result, err
		}
		if err := access.verify(ctx, q); err != nil {
			return result, err
		}
		if cart.Version != r.version {
			return result, ErrStaleCart
		}
		row, err = q.InsertGuestIntent(ctx, db.InsertGuestIntentParams{
			ID: r.guestIntent, GuestID: access.owner, IdempotencyKey: guestKey(r), SourceCartID: cart.ID,
			CartVersion: pgtype.Int8{Int64: r.version, Valid: true}, PaymentScenario: pgtype.Text{String: r.scenario, Valid: true},
			PayloadHash: hash[:], ContactDigest: contactHash[:], ContactEmail: pgtype.Text{String: contact, Valid: true},
			ShippingAddress: shipping,
		})
		if err != nil {
			return result, intentInsertError(err)
		}
		result.created = true
		result.intent, err = viewGuestIntent(row)
		return result, err
	})

	return result.intent, result.created, err
}

func intentInsertError(err error) error {
	var pgError *pgconn.PgError
	if errors.As(err, &pgError) && pgError.Code == "23505" {
		if pgError.ConstraintName == "guest_one_prepared_intent" {
			return commerce.ErrGuestCheckout
		}
		return ErrIdempotencyConflict
	}

	return err
}

func ensureGuestIntentCapacity(ctx context.Context, q *db.Queries, guest pgtype.UUID) error {
	count, err := q.CountGuestIntents(ctx, guest)
	if err == nil && count >= 100 {
		return errGuestIntentCapacity
	}

	return err
}

func lockGuestKey(ctx context.Context, q *db.Queries, access guestAccess, r validatedRequest) error {
	if access.owner != r.guest || !access.full() && access.grant.intent != r.guestIntent {
		return errGuestRecovery
	}

	if err := access.lock(ctx, q); err != nil {
		return err
	}

	if err := q.LockCheckoutKey(ctx, r.lock()); err != nil {
		return err
	}

	return access.verify(ctx, q)
}

func findGuestIntent(ctx context.Context, q *db.Queries, r validatedRequest) (db.GuestCheckoutIntent, error) {
	row, err := q.LockGuestIntentByKey(ctx, db.LockGuestIntentByKeyParams{GuestID: r.guest, IdempotencyKey: guestKey(r)})
	if err == nil {
		if row.ID != r.guestIntent {
			return db.GuestCheckoutIntent{}, ErrIdempotencyConflict
		}
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return row, err
	}

	_, err = q.GuestIntentByID(ctx, db.GuestIntentByIDParams{ID: r.guestIntent, GuestID: r.guest})
	if err == nil {
		return row, ErrIdempotencyConflict
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return row, errGuestIntentNotFound
	}

	return row, err
}

func (s *GuestService) getIntent(ctx context.Context, access guestAccess, id pgtype.UUID) (guestIntentView, error) {
	return stateTransaction(ctx, s.checkout.pool, func(q *db.Queries) (guestIntentView, error) {
		if err := access.lock(ctx, q); err != nil {
			return guestIntentView{}, err
		}
		row, err := q.GuestIntentByID(ctx, db.GuestIntentByIDParams{ID: id, GuestID: access.owner})
		if errors.Is(err, pgx.ErrNoRows) {
			return guestIntentView{}, errGuestIntentNotFound
		}
		if err != nil {
			return guestIntentView{}, err
		}
		r := validatedRequest{guest: access.owner, guestIntent: id, key: row.IdempotencyKey.String()}
		if err := q.LockCheckoutKey(ctx, r.lock()); err != nil {
			return guestIntentView{}, err
		}
		if err := access.verify(ctx, q); err != nil {
			return guestIntentView{}, err
		}
		row, err = expireGuestIntent(ctx, q, row)
		if err != nil {
			return guestIntentView{}, err
		}
		return viewGuestIntent(row)
	})
}

func expireGuestIntent(ctx context.Context, q *db.Queries, row db.GuestCheckoutIntent) (db.GuestCheckoutIntent, error) {
	if row.State != "prepared" {
		return row, nil
	}

	now, err := q.GuestDatabaseTime(ctx)
	if err != nil || row.ExpiresAt.Time.After(now.Time) {
		return row, err
	}

	if err := closeGuestIntent(ctx, q, row, "expired"); err != nil {
		return row, err
	}

	row.State, row.ContactEmail, row.ShippingAddress = "expired", pgtype.Text{}, nil

	return row, nil
}

func closeGuestIntent(ctx context.Context, q *db.Queries, row db.GuestCheckoutIntent, state string) error {
	return changedOne(q.CloseGuestIntent(ctx, db.CloseGuestIntentParams{ID: row.ID, GuestID: row.GuestID, State: state, PreviousState: row.State}))
}

type guestRetirement struct {
	State string `json:"state"`
	Order *Order `json:"order,omitempty"`
}

func (s *GuestService) retire(ctx context.Context, access guestAccess, r validatedRequest) (guestRetirement, error) {
	return stateTransaction(ctx, s.checkout.pool, func(q *db.Queries) (guestRetirement, error) {
		if err := lockGuestKey(ctx, q, access, r); err != nil {
			return guestRetirement{}, err
		}

		row, err := findGuestIntent(ctx, q, r)
		if errors.Is(err, errGuestIntentNotFound) && access.full() {
			if err := ensureGuestIntentCapacity(ctx, q, access.owner); err != nil {
				return guestRetirement{}, err
			}
			_, err := q.InsertRetiredGuestIntent(ctx, db.InsertRetiredGuestIntentParams{ID: r.guestIntent, GuestID: r.guest, IdempotencyKey: guestKey(r)})
			return guestRetirement{State: "retired"}, intentInsertError(err)
		}
		if err != nil {
			return guestRetirement{}, err
		}

		switch row.State {
		case "known_order":
			order, err := loadOrder(ctx, q, db.CheckoutOrderParams{ID: row.OrderID, GuestID: r.guest})
			return guestRetirement{State: "known_order", Order: &order}, err
		case "prepared", "expired", "rejected":
			if err := closeGuestIntent(ctx, q, row, "retired"); err != nil {
				return guestRetirement{}, err
			}
		case "retired":
		default:
			return guestRetirement{}, ErrIntegrity
		}

		return guestRetirement{State: "retired"}, nil
	})
}
