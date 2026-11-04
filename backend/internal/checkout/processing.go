package checkout

import (
	"context"
	"errors"
	randv2 "math/rand/v2"
	"time"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Claim struct {
	Order   Order
	Attempt Attempt
	Claimed bool
}

func orderInput(userID, orderID string) (db.LockOwnedOrderParams, error) {
	user, err := parseID(userID)
	if err != nil {
		return db.LockOwnedOrderParams{}, ErrUnauthorized
	}

	order, err := parseID(orderID)
	if err != nil {
		return db.LockOwnedOrderParams{}, err
	}

	return db.LockOwnedOrderParams{ID: order, UserID: user}, nil
}

// Claim obtains persisted processing ownership. An existing processing attempt
// is returned without ownership; only explicit recovery may resume it later.
func (s *Service) Claim(ctx context.Context, userID, orderID string) (Claim, error) {
	input, err := orderInput(userID, orderID)
	if err != nil {
		return Claim{}, err
	}
	return s.claim(ctx, input)
}

func (s *Service) claim(ctx context.Context, input db.LockOwnedOrderParams) (Claim, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	return stateTransaction(ctx, s.pool, func(q *db.Queries) (Claim, error) {
		graph, err := lockGraph(ctx, q, input)
		if err != nil {
			return Claim{}, err
		}
		claimed := graph.payment.Status == "pending"
		if claimed {
			changed, err := q.ClaimPayment(ctx, graph.payment.ID)
			if err := changedOne(changed, err); err != nil {
				return Claim{}, err
			}
		}
		view, err := loadOrder(ctx, q, db.CheckoutOrderParams(input))
		return Claim{Order: view, Attempt: Attempt{ID: graph.payment.ID.String(), Scenario: graph.payment.Scenario}, Claimed: claimed}, err
	})
}

// Process is used only for a new checkout or an explicit operator/recovery call.
// Repeated checkout keys and GET endpoints never invoke it.
func (s *Service) Process(ctx context.Context, userID, orderID string) (Order, error) {
	input, err := orderInput(userID, orderID)
	if err != nil {
		return Order{}, err
	}
	return s.process(ctx, input)
}

func (s *Service) process(ctx context.Context, input db.LockOwnedOrderParams) (Order, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	claim, err := s.claim(ctx, input)
	if err != nil {
		return Order{}, err
	}

	if !claim.Claimed {
		if claim.Order.Status == "pending_payment" {
			return Order{}, ErrProcessingInProgress
		}
		return claim.Order, nil
	}

	decision, err := s.simulator.Evaluate(ctx, claim.Attempt)
	if err != nil {
		return Order{}, err
	}

	return s.settle(ctx, input, claim.Attempt.ID, decision)
}

// Settle is T2. The outcome must match the immutable stored scenario; callers
// cannot choose a different financial result for the same attempt.
func (s *Service) Settle(ctx context.Context, userID, orderID, attemptID string, decision Decision) (Order, error) {
	input, err := orderInput(userID, orderID)
	if err != nil {
		return Order{}, err
	}
	return s.settle(ctx, input, attemptID, decision)
}

func (s *Service) settle(ctx context.Context, input db.LockOwnedOrderParams, attemptID string, decision Decision) (Order, error) {
	attempt, err := parseID(attemptID)
	if err != nil {
		return Order{}, err
	}

	history, err := newID()
	if err != nil {
		return Order{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	return stateTransaction(ctx, s.pool, func(q *db.Queries) (Order, error) {
		graph, err := lockGraph(ctx, q, input)
		if err != nil {
			return Order{}, err
		}
		if graph.payment.ID != attempt {
			return Order{}, ErrIntegrity
		}
		expected, err := (LocalSimulator{}).Evaluate(ctx, Attempt{ID: attempt.String(), Scenario: graph.payment.Scenario})
		if err != nil || decision != expected {
			return Order{}, ErrIntegrity
		}
		switch graph.order.Status {
		case "confirmed", "payment_failed":
			return loadOrder(ctx, q, db.CheckoutOrderParams(input))
		case "cancelled":
			return Order{}, ErrSettlementConflict
		case "pending_payment":
			if graph.payment.Status != "processing" {
				return Order{}, ErrSettlementConflict
			}
		default:
			return Order{}, ErrIntegrity
		}
		orderStatus, paymentStatus, reservationStatus, reason := "payment_failed", "failed", "released", "payment_failed"
		failure := pgtype.Text{String: "simulated_decline", Valid: true}
		if decision == Accepted {
			orderStatus, paymentStatus, reservationStatus, reason = "confirmed", "succeeded", "consumed", "payment_succeeded"
			failure = pgtype.Text{}
		}
		if err := finishGraph(ctx, q, graph, history, orderStatus, paymentStatus, reservationStatus, reason, failure); err != nil {
			return Order{}, err
		}
		return loadOrder(ctx, q, db.CheckoutOrderParams(input))
	})
}

func (s *Service) Cancel(ctx context.Context, userID, orderID string) (Order, error) {
	input, err := orderInput(userID, orderID)
	if err != nil {
		return Order{}, err
	}
	return s.cancelOrder(ctx, input, func(ctx context.Context, q *db.Queries) error {
		_, err := readActor(ctx, q, userID)
		return err
	}, nil)
}

func (s *Service) cancelOrder(ctx context.Context, input db.LockOwnedOrderParams, authorize, recheck func(context.Context, *db.Queries) error) (Order, error) {
	history, err := newID()
	if err != nil {
		return Order{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := stateTransaction(ctx, s.pool, func(q *db.Queries) (Order, error) {
		if err := authorize(ctx, q); err != nil {
			return Order{}, err
		}
		graph, err := lockGraph(ctx, q, input)
		if err != nil {
			return Order{}, err
		}
		if recheck != nil {
			if err := recheck(ctx, q); err != nil {
				return Order{}, err
			}
		}
		switch graph.order.Status {
		case "cancelled":
			return loadOrder(ctx, q, db.CheckoutOrderParams(input))
		case "confirmed", "payment_failed":
			return Order{}, ErrCancellationConflict
		case "pending_payment":
			if graph.payment.Status != "pending" {
				return Order{}, ErrCancellationConflict
			}
		default:
			return Order{}, ErrIntegrity
		}
		if err := finishGraph(ctx, q, graph, history, "cancelled", "cancelled", "released", "customer_cancelled", pgtype.Text{}); err != nil {
			return Order{}, err
		}
		if recheck != nil {
			if err := recheck(ctx, q); err != nil {
				return Order{}, err
			}
		}
		return loadOrder(ctx, q, db.CheckoutOrderParams(input))
	})
	if !errors.Is(err, ErrOutcomeUncertain) {
		return result, err
	}

	known, readErr := s.freshOrder(ctx, input)
	if readErr == nil && known.Status == "cancelled" {
		if recheck != nil {
			read, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer cancel()
			if err := recheck(read, db.New(s.pool)); err != nil {
				return Order{}, ErrOrderOutcomeUncertain
			}
		}
		return known, nil
	}

	return Order{}, ErrOrderOutcomeUncertain
}

func finishGraph(ctx context.Context, q *db.Queries, graph orderGraph, history pgtype.UUID, orderStatus, paymentStatus, reservationStatus, reason string, failure pgtype.Text) error {
	for _, reservation := range graph.reservations {
		var changed int64
		var err error
		if reservationStatus == "consumed" {
			changed, err = q.ConsumeReservedStock(ctx, db.ConsumeReservedStockParams{ProductID: reservation.ProductID, Quantity: reservation.Quantity})
		} else {
			changed, err = q.ReleaseReservedStock(ctx, db.ReleaseReservedStockParams{ProductID: reservation.ProductID, Quantity: reservation.Quantity})
		}
		if err := changedOne(changed, err); err != nil {
			return err
		}
		changed, err = q.TransitionReservation(ctx, db.TransitionReservationParams{ID: reservation.ID, Status: reservationStatus})
		if err := changedOne(changed, err); err != nil {
			return err
		}
	}

	changed, err := q.FinishPayment(ctx, db.FinishPaymentParams{ID: graph.payment.ID, ExpectedStatus: graph.payment.Status, NewStatus: paymentStatus, FailureCode: failure})
	if err := changedOne(changed, err); err != nil {
		return err
	}

	changed, err = q.FinishOrder(ctx, db.FinishOrderParams{ID: graph.order.ID, Status: orderStatus})
	if err := changedOne(changed, err); err != nil {
		return err
	}

	return q.AppendOrderHistory(ctx, db.AppendOrderHistoryParams{ID: history, OrderID: graph.order.ID, NewStatus: orderStatus, Reason: pgtype.Text{String: reason, Valid: true}})
}

func changedOne(changed int64, err error) error {
	if err != nil {
		return err
	}
	if changed != 1 {
		return ErrIntegrity
	}
	return nil
}

// Confirmed transaction aborts are the only automatic retries. Transport errors
// at COMMIT remain uncertain and are resolved by the caller's durable state read.
func stateTransaction[T any](ctx context.Context, pool *pgxpool.Pool, work func(*db.Queries) (T, error)) (T, error) {
	var zero T
	for attempt := 0; attempt < 3; attempt++ {
		result, err := stateAttempt(ctx, pool, work)
		if err == nil || !retryable(err) || attempt == 2 {
			return result, err
		}
		timer := time.NewTimer(time.Duration(25+randv2.IntN(76)) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return zero, ctx.Err()
		case <-timer.C:
		}
	}

	return zero, ErrIntegrity
}

func stateAttempt[T any](ctx context.Context, pool *pgxpool.Pool, work func(*db.Queries) (T, error)) (T, error) {
	var zero T
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return zero, err
	}
	defer rollback(ctx, tx)

	result, err := work(db.New(tx))
	if err != nil {
		return zero, err
	}

	if err := tx.Commit(ctx); err != nil {
		var pgError *pgconn.PgError
		if errors.As(err, &pgError) || errors.Is(err, pgx.ErrTxCommitRollback) {
			return zero, err
		}
		return zero, ErrOutcomeUncertain
	}

	return result, nil
}
