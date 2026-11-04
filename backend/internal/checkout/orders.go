package checkout

import (
	"context"
	"errors"
	"time"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// Checkout executes processing only after a newly acknowledged T1. Every
// retained result returns immediately, even if it still needs operator recovery.
func (s *Service) Checkout(ctx context.Context, userID, key string, input Request) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	created, err := s.CreatePending(ctx, userID, key, input)
	if err != nil || created.Replayed {
		return created, err
	}

	owned, err := orderInput(userID, created.Order.ID)
	if err != nil {
		return Result{}, err
	}
	return s.finishCheckout(ctx, owned, created)
}

func (s *Service) finishCheckout(ctx context.Context, owned db.LockOwnedOrderParams, created Result) (Result, error) {
	order, err := s.process(ctx, owned)
	if err == nil {
		return Result{Order: order}, nil
	}
	if errors.Is(err, ErrIntegrity) {
		return Result{}, err
	}

	known, readErr := s.freshOrder(ctx, owned)
	if readErr != nil {
		if errors.Is(readErr, ErrIntegrity) {
			return Result{}, readErr
		}
		return Result{}, ErrOutcomeUncertain
	}

	return Result{Order: known, Interrupted: known.Status == "pending_payment"}, nil
}

func readActor(ctx context.Context, q *db.Queries, userID string) (pgtype.UUID, error) {
	user, err := parseID(userID)
	if err != nil {
		return pgtype.UUID{}, ErrUnauthorized
	}

	if _, err := q.CheckoutActor(ctx, user); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pgtype.UUID{}, ErrUnauthorized
		}
		return pgtype.UUID{}, err
	}

	return user, nil
}

func (s *Service) GetOrder(ctx context.Context, userID, orderID string) (Order, error) {
	input, err := orderInput(userID, orderID)
	if err != nil {
		return Order{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	q := db.New(s.pool)
	if _, err := readActor(ctx, q, userID); err != nil {
		return Order{}, err
	}

	exists, err := q.OwnedOrderExists(ctx, db.OwnedOrderExistsParams{ID: input.ID, UserID: input.UserID})
	if err != nil {
		return Order{}, err
	}
	if !exists {
		return Order{}, ErrOrderNotFound
	}

	return loadOrder(ctx, q, db.CheckoutOrderParams{ID: input.ID, UserID: input.UserID})
}

func (s *Service) ListOrders(ctx context.Context, userID string, limit, offset int64) ([]Order, error) {
	if limit < 1 || limit > 100 || offset < 0 {
		return nil, ErrInvalidInput
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}

	defer rollback(ctx, tx)

	q := db.New(tx)
	user, err := readActor(ctx, q, userID)
	if err != nil {
		return nil, err
	}

	return readOrderPage(ctx, q, db.ListOwnedOrderIDsParams{UserID: user, PageLimit: limit, PageOffset: offset})
}

func readOrderPage(ctx context.Context, q *db.Queries, page db.ListOwnedOrderIDsParams) ([]Order, error) {
	ids, err := q.ListOwnedOrderIDs(ctx, page)
	if err != nil {
		return nil, err
	}

	result := make([]Order, 0, len(ids))
	for _, id := range ids {
		order, err := loadOrder(ctx, q, db.CheckoutOrderParams{ID: id, UserID: page.UserID, GuestID: page.GuestID})
		if err != nil {
			return nil, err
		}
		result = append(result, order)
	}

	return result, nil
}

func (s *Service) Payments(ctx context.Context, userID, orderID string) ([]Payment, error) {
	input, err := orderInput(userID, orderID)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)

	q := db.New(tx)
	if _, err := readActor(ctx, q, userID); err != nil {
		return nil, err
	}

	exists, err := q.OwnedOrderExists(ctx, db.OwnedOrderExistsParams{ID: input.ID, UserID: input.UserID})
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrOrderNotFound
	}

	row, err := q.CheckoutOrder(ctx, db.CheckoutOrderParams{ID: input.ID, UserID: input.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrIntegrity
	}
	if err != nil {
		return nil, err
	}

	payments, err := q.ReadOrderPayments(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	if len(payments) != 1 {
		return nil, ErrIntegrity
	}

	result := make([]Payment, 0, len(payments))
	for _, payment := range payments {
		if err := validatePayment(row.Order, payment); err != nil {
			return nil, err
		}
		result = append(result, paymentView(payment))
	}

	return result, nil
}

func paymentView(payment db.PaymentAttempt) Payment {
	var failure *string
	if payment.FailureCode.Valid {
		value := payment.FailureCode.String
		failure = &value
	}

	return Payment{
		ID:          payment.ID.String(),
		Status:      payment.Status,
		FailureCode: failure,
		CreatedAt:   payment.CreatedAt.Time,
	}
}

// freshOrder waits for an in-flight writer on an independent healthy pooled
// connection. It never substitutes a stale pre-processing T1 snapshot for an
// unknown current outcome, and it never performs payment or recovery work.
func (s *Service) freshOrder(ctx context.Context, input db.LockOwnedOrderParams) (Order, error) {
	resolution, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()

	connection, err := s.pool.Acquire(resolution)
	if err != nil {
		return Order{}, err
	}
	defer connection.Release()

	tx, err := connection.BeginTx(resolution, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Order{}, err
	}
	defer rollback(resolution, tx)

	q := db.New(tx)
	if _, err := q.ReadLockOwnedOrder(resolution, db.ReadLockOwnedOrderParams(input)); err != nil {
		return Order{}, err
	}

	return loadOrder(resolution, q, db.CheckoutOrderParams(input))
}
