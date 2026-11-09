package checkout

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	randv2 "math/rand/v2"
	"time"

	"ecom/backend/internal/commerce"
	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/metrics"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool      *pgxpool.Pool
	simulator Simulator
	metrics   *metrics.Recorder
}

// UseMetrics counts orders, payment results and unknown outcomes for account
// and guest checkout, and rejections by the guest checkout limiters. Call it
// before creating handlers. Nil counts nothing.
func (s *Service) UseMetrics(recorder *metrics.Recorder) *Service {
	s.metrics = recorder
	return s
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, simulator: LocalSimulator{}}
}

// NewServiceWithSimulator supplies the only nondatabase processing boundary.
// Production uses NewService; fault behavior is supplied solely by test code.
func NewServiceWithSimulator(pool *pgxpool.Pool, simulator Simulator) (*Service, error) {
	if pool == nil || simulator == nil {
		return nil, ErrInvalidInput
	}
	return &Service{pool: pool, simulator: simulator}, nil
}

// CreatePending implements all of T1. userID is the trusted authenticated
// principal, never a customer-controlled body field. This method never simulates
// payment or automatically resumes an existing order.
func (s *Service) CreatePending(ctx context.Context, userID, key string, input Request) (Result, error) {
	r, err := validate(userID, key, input)
	if err != nil {
		return Result{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	q := db.New(s.pool)
	if _, err := q.CheckoutActor(ctx, r.user); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, ErrUnauthorized
		}
		return Result{}, err
	}

	if result, found, err := lookup(ctx, q, r); err != nil || found {
		return result, err
	}

	ids, err := newIdentities()
	if err != nil {
		return Result{}, err
	}

	for attempt := 0; attempt < 3; attempt++ {
		result, err := s.create(ctx, r, ids)
		if errors.Is(err, ErrOutcomeUncertain) {
			return s.resolve(ctx, r)
		}
		if err == nil || !retryable(err) || attempt == 2 {
			return result, err
		}
		timer := time.NewTimer(time.Duration(25+randv2.IntN(76)) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return Result{}, ctx.Err()
		case <-timer.C:
		}
	}

	return Result{}, ErrIntegrity
}

func retryable(err error) bool {
	var pgError *pgconn.PgError
	return errors.As(err, &pgError) && (pgError.Code == "40P01" || pgError.Code == "40001")
}

func rollback(ctx context.Context, tx pgx.Tx) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()
	_ = tx.Rollback(cleanup)
}

func (s *Service) create(ctx context.Context, r validatedRequest, ids *identities) (Result, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Result{}, err
	}
	defer rollback(ctx, tx)

	q := db.New(tx)
	if err := q.LockCheckoutKey(ctx, r.lock()); err != nil {
		return Result{}, err
	}

	if result, found, err := lookup(ctx, q, r); err != nil || found {
		return result, err
	}

	cart, err := q.LockCart(ctx, r.user)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, ErrIntegrity
	}
	if err != nil {
		return Result{}, err
	}

	lines, err := checkoutLines(ctx, q, cart, r.version)
	if err != nil {
		return Result{}, err
	}

	address, err := q.CheckoutAddress(ctx, db.CheckoutAddressParams{ID: r.address, UserID: r.user})
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, ErrAddressNotFound
	}
	if err != nil {
		return Result{}, err
	}

	shipping, err := snapshotAddress(address)
	if err != nil {
		return Result{}, err
	}

	view, err := writePending(ctx, q, r, ids, cart, lines, shipping)
	if err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		var pgError *pgconn.PgError
		if errors.As(err, &pgError) || errors.Is(err, pgx.ErrTxCommitRollback) {
			return Result{}, err
		}
		return Result{}, ErrOutcomeUncertain
	}
	return view, nil
}

func checkoutLines(ctx context.Context, q *db.Queries, cart db.Cart, version int64) ([]db.CheckoutLinesRow, error) {
	if cart.Version != version {
		return nil, ErrStaleCart
	}
	if cart.Version >= commerce.MaxCartVersion {
		return nil, ErrVersionExhausted
	}
	lines, err := q.CheckoutLines(ctx, cart.ID)
	if err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		return nil, ErrEmptyCart
	}
	if len(lines) > commerce.MaxCartItems {
		return nil, ErrInvalidInput
	}
	return lines, nil
}

func writePending(ctx context.Context, q *db.Queries, r validatedRequest, ids *identities, cart db.Cart, lines []db.CheckoutLinesRow, shipping ShippingAddress) (Result, error) {
	var err error
	total := int64(0)
	lineTotals := make([]int64, len(lines))
	for i, line := range lines {
		if !line.IsActive {
			return Result{}, ErrProductUnavailable
		}
		lineTotals[i], err = lineTotal(line.UnitPriceCents, int64(line.Quantity))
		if err != nil {
			return Result{}, err
		}
		total, err = addTotal(total, lineTotals[i])
		if err != nil {
			return Result{}, err
		}
	}

	// CheckoutLines orders UUIDs in PostgreSQL's UUID-byte order. Every hold
	// follows this order, independent of the customer's insertion order.
	for _, line := range lines {
		changed, err := q.ReserveCheckoutStock(ctx, db.ReserveCheckoutStockParams{ProductID: line.ProductID, Quantity: line.Quantity})
		if err != nil {
			return Result{}, err
		}
		if changed != 1 {
			return Result{}, ErrInsufficientInventory
		}
	}

	encoded, err := json.Marshal(shipping)
	if err != nil {
		return Result{}, err
	}

	order, err := q.CreatePendingOrder(ctx, db.CreatePendingOrderParams{
		ID:                ids.order,
		UserID:            r.user,
		GuestID:           r.guest,
		GuestIntentID:     r.guestIntent,
		ContactEmail:      r.contactEmail,
		SubtotalCents:     total,
		ShippingAddress:   encoded,
		SourceCartID:      cart.ID,
		SourceCartVersion: r.version,
	})
	if err != nil {
		return Result{}, err
	}

	for i, line := range lines {
		lineIDs, err := ids.forLine(line.ProductID)
		if err != nil {
			return Result{}, err
		}
		if _, err := q.CreateCheckoutItem(ctx, db.CreateCheckoutItemParams{
			ID:                  lineIDs.item,
			OrderID:             order.ID,
			ProductID:           line.ProductID,
			SkuSnapshot:         line.Sku,
			ProductNameSnapshot: line.Name,
			Quantity:            line.Quantity,
			UnitPriceCents:      line.UnitPriceCents,
			LineTotalCents:      lineTotals[i],
		}); err != nil {
			return Result{}, err
		}

		if err := q.CreateCheckoutReservation(ctx, db.CreateCheckoutReservationParams{
			ID:          lineIDs.reservation,
			OrderItemID: lineIDs.item,
			ProductID:   line.ProductID,
			Quantity:    line.Quantity,
			ExpiresAt:   order.ReservationExpiresAt,
		}); err != nil {
			return Result{}, err
		}
	}

	if err := q.CreateInitialPayment(ctx, db.CreateInitialPaymentParams{
		ID:                 ids.payment,
		OrderID:            order.ID,
		Scenario:           r.scenario,
		SimulatorReference: ids.payment.String(),
	}); err != nil {
		return Result{}, err
	}

	if err := q.CreateInitialHistory(ctx, db.CreateInitialHistoryParams{
		ID:      ids.history,
		OrderID: order.ID,
	}); err != nil {
		return Result{}, err
	}

	if err := q.RecordCheckoutIntent(ctx, db.RecordCheckoutIntentParams{
		ID:             ids.idempotency,
		UserID:         r.user,
		GuestID:        r.guest,
		IdempotencyKey: r.key,
		RequestHash:    r.fingerprint(cart.ID),
		OrderID:        order.ID,
	}); err != nil {
		return Result{}, err
	}

	if err := q.ClearCart(ctx, cart.ID); err != nil {
		return Result{}, err
	}

	if _, err := q.IncrementCartVersion(ctx, cart.ID); err != nil {
		return Result{}, err
	}

	view, err := loadOrder(ctx, q, db.CheckoutOrderParams{
		ID:      order.ID,
		UserID:  r.user,
		GuestID: r.guest,
	})
	if err != nil {
		return Result{}, err
	}

	return Result{Order: view}, nil
}

func snapshotAddress(a db.Address) (ShippingAddress, error) {
	address, err := commerce.NormalizeShippingAddress(commerce.Address{
		Label:         a.Label.String,
		RecipientName: a.RecipientName,
		Line1:         a.Line1,
		Line2:         a.Line2.String,
		City:          a.City,
		Region:        a.Region,
		PostalCode:    a.PostalCode,
		CountryCode:   a.CountryCode,
	})
	if err != nil {
		return ShippingAddress{}, ErrAddressNotFound
	}

	return ShippingAddress{
		Label:         address.Label,
		RecipientName: address.RecipientName,
		Line1:         address.Line1,
		Line2:         address.Line2,
		City:          address.City,
		Region:        address.Region,
		PostalCode:    address.PostalCode,
		CountryCode:   address.CountryCode,
	}, nil
}

func lookup(ctx context.Context, q *db.Queries, r validatedRequest) (Result, bool, error) {
	stored, err := q.FindCheckoutIntent(ctx, db.FindCheckoutIntentParams{
		UserID:         r.user,
		IdempotencyKey: r.key,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, false, nil
	}
	if err != nil {
		return Result{}, false, err
	}

	if r.fingerprint(stored.SourceCartID) != stored.RequestHash {
		return Result{}, true, ErrIdempotencyConflict
	}

	order, err := loadOrder(ctx, q, db.CheckoutOrderParams{
		ID:     stored.OrderID,
		UserID: r.user,
	})

	return Result{Order: order, Replayed: true}, true, err
}

func loadOrder(ctx context.Context, q *db.Queries, input db.CheckoutOrderParams) (Order, error) {
	if input.UserID.Valid == input.GuestID.Valid {
		return Order{}, ErrIntegrity
	}
	// Mutable order/payment fields are read in one statement. Item and shipping
	// snapshots are immutable, so the following item query cannot mix revisions.
	row, err := q.CheckoutOrder(ctx, input)
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, ErrIntegrity
	}
	if err != nil {
		return Order{}, err
	}

	items, err := q.CheckoutOrderItems(ctx, input.ID)
	if err != nil {
		return Order{}, err
	}

	if len(items) < 1 || len(items) > commerce.MaxCartItems {
		return Order{}, ErrIntegrity
	}

	var shipping ShippingAddress
	if err := json.Unmarshal(row.Order.ShippingAddress, &shipping); err != nil {
		return Order{}, fmt.Errorf("%w: invalid shipping snapshot", ErrIntegrity)
	}

	payment := row.PaymentAttempt
	if err := validatePayment(row.Order, payment); err != nil {
		return Order{}, ErrIntegrity
	}

	result := Order{
		ID:              row.Order.ID.String(),
		Status:          row.Order.Status,
		TotalCents:      row.Order.TotalCents,
		Currency:        row.Order.Currency,
		ShippingAddress: shipping,
		CreatedAt:       row.Order.CreatedAt.Time,
		Payment:         paymentView(payment),
		Items:           make([]Item, 0, len(items)),
	}
	for _, item := range items {
		result.Items = append(result.Items, Item{
			ID:             item.ID.String(),
			ProductID:      item.ProductID.String(),
			SKU:            item.SkuSnapshot,
			Name:           item.ProductNameSnapshot,
			Quantity:       item.Quantity,
			UnitPriceCents: item.UnitPriceCents,
			LineTotalCents: item.LineTotalCents,
		})
	}

	return result, nil
}

func (s *Service) resolve(ctx context.Context, r validatedRequest) (Result, error) {
	// A request can lose its commit acknowledgement at its deadline. Allow one
	// separate, bounded second for a fresh-connection lookup, even after request
	// cancellation. Never replay T1 here or infer rollback from a missing key.
	resolution, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()

	// pgx discards the failed transaction connection. Acquire an independent
	// healthy connection through the existing pool to retain its resource bound.
	connection, err := s.pool.Acquire(resolution)
	if err != nil {
		return Result{}, ErrOutcomeUncertain
	}
	defer connection.Release()

	tx, err := connection.BeginTx(resolution, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Result{}, ErrOutcomeUncertain
	}
	defer rollback(resolution, tx)

	q := db.New(tx)
	// The original transaction owns this lock until commit/rollback. Waiting
	// on it establishes a visibility barrier before inspecting the retained key.
	if err := q.LockCheckoutKey(resolution, r.lock()); err != nil {
		return Result{}, ErrOutcomeUncertain
	}

	result, found, err := lookup(resolution, q, r)
	if errors.Is(err, ErrIdempotencyConflict) {
		return Result{}, err
	}
	if err != nil || !found {
		return Result{}, ErrOutcomeUncertain
	}

	return result, nil
}

func consistentState(order, payment string) bool {
	switch order {
	case "pending_payment":
		return payment == "pending" || payment == "processing"
	case "confirmed":
		return payment == "succeeded"
	case "payment_failed":
		return payment == "failed"
	case "cancelled":
		return payment == "cancelled"
	default:
		return false // Corrupted/unrecognized state must fail closed.
	}
}
