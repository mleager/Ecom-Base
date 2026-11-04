package checkout

import (
	"bytes"
	"context"
	"errors"
	"time"

	"ecom/backend/internal/commerce"
	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
)

type orderGraph struct {
	order        db.Order
	payment      db.PaymentAttempt
	items        []db.OrderItem
	reservations []db.InventoryReservation
}

func validatePayment(order db.Order, payment db.PaymentAttempt) error {
	if !consistentState(order.Status, payment.Status) || payment.OrderID != order.ID || payment.AttemptNumber != 1 || payment.SimulatorReference != payment.ID.String() || (payment.Scenario != "accept" && payment.Scenario != "reject") {
		return ErrIntegrity
	}

	switch payment.Status {
	case "pending":
		if payment.StartedAt.Valid || payment.CompletedAt.Valid || payment.FailureCode.Valid {
			return ErrIntegrity
		}
	case "processing":
		if !payment.StartedAt.Valid || payment.CompletedAt.Valid || payment.FailureCode.Valid {
			return ErrIntegrity
		}
	case "succeeded", "failed":
		if !payment.StartedAt.Valid || !payment.CompletedAt.Valid || payment.CompletedAt.Time.Before(payment.StartedAt.Time) {
			return ErrIntegrity
		}
		if payment.Status == "succeeded" && (payment.Scenario != "accept" || payment.FailureCode.Valid) {
			return ErrIntegrity
		}
		if payment.Status == "failed" && (payment.Scenario != "reject" || !payment.FailureCode.Valid || payment.FailureCode.String != "simulated_decline") {
			return ErrIntegrity
		}
	case "cancelled":
		if payment.StartedAt.Valid || !payment.CompletedAt.Valid || payment.FailureCode.Valid {
			return ErrIntegrity
		}
	default:
		return ErrIntegrity
	}

	return nil
}

func validateGraph(graph orderGraph) error {
	if err := validatePayment(graph.order, graph.payment); err != nil {
		return err
	}

	if len(graph.items) < 1 || len(graph.items) > commerce.MaxCartItems || len(graph.items) != len(graph.reservations) || graph.order.Currency != "USD" || !graph.order.ReservationExpiresAt.Time.Equal(graph.order.CreatedAt.Time.Add(15*time.Minute)) {
		return ErrIntegrity
	}

	expected := ""
	switch graph.order.Status {
	case "pending_payment":
		expected = "active"
	case "confirmed":
		expected = "consumed"
	case "payment_failed", "cancelled":
		expected = "released"
	default:
		return ErrIntegrity
	}

	items := make(map[string]db.OrderItem, len(graph.items))
	total := int64(0)
	for _, item := range graph.items {
		line, err := lineTotal(item.UnitPriceCents, int64(item.Quantity))
		if err != nil || line != item.LineTotalCents || item.OrderID != graph.order.ID {
			return ErrIntegrity
		}
		total, err = addTotal(total, line)
		if err != nil {
			return ErrIntegrity
		}
		if _, duplicate := items[item.ID.String()]; duplicate {
			return ErrIntegrity
		}
		items[item.ID.String()] = item
	}

	if total != graph.order.TotalCents || total != graph.order.SubtotalCents {
		return ErrIntegrity
	}

	for i, reservation := range graph.reservations {
		item, exists := items[reservation.OrderItemID.String()]
		if !exists || reservation.ProductID != item.ProductID || reservation.Quantity != item.Quantity || reservation.Status != expected || !reservation.ExpiresAt.Time.Equal(graph.order.ReservationExpiresAt.Time) {
			return ErrIntegrity
		}
		delete(items, reservation.OrderItemID.String())
		if i > 0 && bytes.Compare(graph.reservations[i-1].ProductID.Bytes[:], reservation.ProductID.Bytes[:]) >= 0 {
			return ErrIntegrity
		}
	}

	return nil
}

// Every writer locks order, payment, reservations in product order, then all
// inventory rows in product order. No network simulation occurs under these locks.
func lockGraph(ctx context.Context, q *db.Queries, input db.LockOwnedOrderParams) (orderGraph, error) {
	if input.UserID.Valid == input.GuestID.Valid {
		return orderGraph{}, ErrIntegrity
	}
	order, err := q.LockOwnedOrder(ctx, input)
	if errors.Is(err, pgx.ErrNoRows) {
		return orderGraph{}, ErrOrderNotFound
	}
	if err != nil {
		return orderGraph{}, err
	}

	payments, err := q.LockOrderPayments(ctx, order.ID)
	if err != nil {
		return orderGraph{}, err
	}

	if len(payments) != 1 {
		return orderGraph{}, ErrIntegrity
	}

	items, err := q.CheckoutOrderItems(ctx, order.ID)
	if err != nil {
		return orderGraph{}, err
	}

	reservations, err := q.LockOrderReservations(ctx, order.ID)
	if err != nil {
		return orderGraph{}, err
	}

	graph := orderGraph{order, payments[0], items, reservations}
	if err := validateGraph(graph); err != nil {
		return orderGraph{}, err
	}

	inventories := make([]db.Inventory, len(reservations))
	for i, reservation := range reservations {
		inventories[i], err = q.LockInventory(ctx, reservation.ProductID)
		if errors.Is(err, pgx.ErrNoRows) {
			return orderGraph{}, ErrIntegrity
		}
		if err != nil {
			return orderGraph{}, err
		}
	}

	// Writers cannot change active reservations for these products without first
	// updating their locked inventory row. Fresh READ COMMITTED queries therefore
	// compare counters with a stable active sum while these inventory locks hold.
	for i, reservation := range reservations {
		sum, err := q.ActiveReservedQuantity(ctx, reservation.ProductID)
		if err != nil {
			return orderGraph{}, err
		}
		if sum != int64(inventories[i].QuantityReserved) {
			return orderGraph{}, ErrIntegrity
		}
	}

	return graph, nil
}
