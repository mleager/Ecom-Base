package checkout

import (
	"context"
	"errors"
	"time"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
)

type recoverySelection struct {
	order   db.Order
	payment db.PaymentAttempt
	valid   bool
	claimed bool
}

// Recover is an explicit operator action. It can re-derive a processing attempt
// because the Project 1 simulator has no external side effect. HTTP reads and
// checkout replays deliberately do not invoke this method.
func (s *Service) Recover(ctx context.Context, limit int, emit func(RecoveryEvent) error) (RecoveryReport, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	report, err := s.inspectRecovery(ctx, limit, nil, false)
	report.Mode = "apply"
	if err != nil && !errors.Is(err, ErrRecoveryIssues) {
		return report, err
	}

	params := db.NextRecoveryOrderParams{Cutoff: recoveryTimestamp(report.Cutoff)}
	for report.Visited < limit {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		itemCtx, stop := context.WithTimeout(ctx, 5*time.Second)
		selected, selectErr := s.selectRecovery(itemCtx, params)
		if !selected.valid {
			stop()
			if errors.Is(selectErr, pgx.ErrNoRows) {
				break
			}
			return report, selectErr
		}
		report.Visited++
		// Even a failed/inconsistent candidate advances this run's cursor. Later
		// explicit runs start fresh; one corrupt row cannot exhaust this run's work.
		params.HasCursor, params.CursorTime, params.CursorID = true, selected.order.ReservationExpiresAt, selected.order.ID
		err := s.recoverSelected(itemCtx, selected, selectErr, &report, emit)
		stop()
		if err != nil {
			return report, err
		}
	}

	return report, recoveryResult(report)
}

func (s *Service) selectRecovery(ctx context.Context, params db.NextRecoveryOrderParams) (recoverySelection, error) {
	var selected recoverySelection
	_, err := stateTransaction(ctx, s.pool, func(q *db.Queries) (struct{}, error) {
		selected = recoverySelection{}
		order, err := q.NextRecoveryOrder(ctx, params)
		if err != nil {
			return struct{}{}, err
		}
		selected.order, selected.valid = order, true
		graph, err := lockGraph(ctx, q, db.LockOwnedOrderParams{ID: order.ID, UserID: order.UserID, GuestID: order.GuestID})
		if err != nil {
			return struct{}{}, err
		}
		selected.payment = graph.payment
		switch graph.payment.Status {
		case "pending":
			changed, err := q.ClaimPayment(ctx, graph.payment.ID)
			if err := changedOne(changed, err); err != nil {
				return struct{}{}, err
			}
			selected.claimed = true
		case "processing":
			// Commit/release every lock before deterministic re-evaluation.
		case "succeeded", "failed", "cancelled":
			// A pending order cannot have a terminal payment; lockGraph rejects it.
			return struct{}{}, ErrIntegrity
		default:
			return struct{}{}, ErrIntegrity
		}
		return struct{}{}, nil
	})

	return selected, err
}

func (s *Service) recoverSelected(ctx context.Context, selected recoverySelection, selectErr error, report *RecoveryReport, emit func(RecoveryEvent) error) error {
	event := RecoveryEvent{OrderID: selected.order.ID.String(), Deadline: selected.order.ReservationExpiresAt.Time, OrderStatus: selected.order.Status}
	owned := db.LockOwnedOrderParams{ID: selected.order.ID, UserID: selected.order.UserID, GuestID: selected.order.GuestID}
	if errors.Is(selectErr, ErrOutcomeUncertain) {
		known, err := s.resolveRecoveryState(ctx, owned)
		if err == nil && known.Payment.ID == selected.payment.ID.String() {
			switch known.Status {
			case "confirmed", "payment_failed", "cancelled":
				report.AlreadyTerminal++
				event.Event, event.OrderStatus, event.PaymentStatus = "already_terminal", known.Status, known.Payment.Status
				return recoveryEvent(emit, event)
			case "pending_payment":
				if known.Payment.Status == "processing" {
					selectErr, selected.claimed = nil, false
				}
			default:
				selectErr = ErrIntegrity
			}
		} else if errors.Is(err, ErrIntegrity) {
			selectErr = err
		}
	}

	if selectErr != nil {
		return recoveryFailure(selectErr, report, emit, event)
	}

	event.Event, event.PaymentStatus = "resumed", "processing"
	if selected.claimed {
		event.Event = "claimed"
	}

	if err := recoveryEvent(emit, event); err != nil {
		return err
	}

	decision, err := s.simulator.Evaluate(ctx, Attempt{ID: selected.payment.ID.String(), Scenario: selected.payment.Scenario})
	if err != nil {
		return recoveryFailure(err, report, emit, event)
	}

	order, err := s.settle(ctx, owned, selected.payment.ID.String(), decision)
	if errors.Is(err, ErrOutcomeUncertain) {
		known, readErr := s.resolveRecoveryState(ctx, owned)
		if readErr == nil && known.Payment.ID == selected.payment.ID.String() && (known.Status == "confirmed" || known.Status == "payment_failed") {
			order, err = known, nil
		} else if errors.Is(readErr, ErrIntegrity) {
			err = readErr
		}
	}
	if err != nil {
		return recoveryFailure(err, report, emit, event)
	}

	report.Settled++
	event.Event, event.OrderStatus, event.PaymentStatus = "settled", order.Status, order.Payment.Status

	return recoveryEvent(emit, event)
}

func recoveryFailure(err error, report *RecoveryReport, emit func(RecoveryEvent) error, event RecoveryEvent) error {
	switch {
	case errors.Is(err, ErrIntegrity):
		report.Inconsistent++
		event.Event, event.Code = "inconsistent", "order_integrity"
	case errors.Is(err, ErrOutcomeUncertain):
		report.Uncertain++
		event.Event, event.Code = "uncertain", "commit_outcome_uncertain"
		event.OrderStatus, event.PaymentStatus = "", ""
	default:
		report.Failed++
		event.Event, event.Code = "failed", "operation_failed"
	}

	return recoveryEvent(emit, event)
}

// The original writer must finish before resolution can lock the same order.
// Full graph validation also prevents a corrupt terminal result from being
// reported as successful merely because its order/payment statuses match.
func (s *Service) resolveRecoveryState(ctx context.Context, input db.LockOwnedOrderParams) (Order, error) {
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
	if _, err := lockGraph(resolution, q, input); err != nil {
		return Order{}, err
	}

	return loadOrder(resolution, q, db.CheckoutOrderParams(input))
}
