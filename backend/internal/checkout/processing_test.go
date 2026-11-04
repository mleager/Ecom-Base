package checkout

import (
	"context"
	"errors"
	"testing"
	"time"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5/pgtype"
)

func testGraph(t *testing.T) orderGraph {
	t.Helper()
	id := func(raw string) pgtype.UUID {
		parsed, err := parseID(raw)
		if err != nil {
			t.Fatal(err)
		}
		return parsed
	}
	orderID := id(testUser)
	itemID := id(testCart)
	productID := id(testAddress)
	paymentID := id("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
	created := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	stamp := func(at time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: at, Valid: true} }
	return orderGraph{
		order:        db.Order{ID: orderID, Status: "pending_payment", SubtotalCents: 150, TotalCents: 150, Currency: "USD", CreatedAt: stamp(created), ReservationExpiresAt: stamp(created.Add(15 * time.Minute))},
		payment:      db.PaymentAttempt{ID: paymentID, OrderID: orderID, AttemptNumber: 1, Status: "pending", Scenario: "accept", SimulatorReference: paymentID.String(), CreatedAt: stamp(created)},
		items:        []db.OrderItem{{ID: itemID, OrderID: orderID, ProductID: productID, Quantity: 3, UnitPriceCents: 50, LineTotalCents: 150}},
		reservations: []db.InventoryReservation{{OrderItemID: itemID, ProductID: productID, Quantity: 3, Status: "active", ExpiresAt: stamp(created.Add(15 * time.Minute))}},
	}
}

func TestLocalSimulator(t *testing.T) {
	id := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	for _, tc := range []struct {
		scenario string
		want     Decision
	}{{"accept", Accepted}, {"reject", Rejected}} {
		for range 100 {
			got, err := (LocalSimulator{}).Evaluate(context.Background(), Attempt{ID: id, Scenario: tc.scenario})
			if err != nil || got != tc.want {
				t.Fatalf("nonrepeatable %s result: %s %v", tc.scenario, got, err)
			}
		}
	}
	for _, attempt := range []Attempt{{ID: id, Scenario: "unknown"}, {ID: "bad", Scenario: "accept"}, {ID: "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD", Scenario: "accept"}, {ID: "00000000-0000-0000-0000-000000000000", Scenario: "accept"}} {
		if _, err := (LocalSimulator{}).Evaluate(context.Background(), attempt); !errors.Is(err, ErrIntegrity) {
			t.Fatal("invalid persisted attempt accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (LocalSimulator{}).Evaluate(ctx, Attempt{ID: id, Scenario: "accept"}); !errors.Is(err, context.Canceled) {
		t.Fatal("simulation ignored cancellation")
	}
	if _, err := NewServiceWithSimulator(nil, LocalSimulator{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("invalid simulator setup accepted")
	}
}

func TestGraphValidation(t *testing.T) {
	if err := validateGraph(testGraph(t)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*orderGraph)
	}{
		{"missing reservation", func(g *orderGraph) { g.reservations = nil }},
		{"missing item", func(g *orderGraph) { g.items = nil }},
		{"wrong quantity", func(g *orderGraph) { g.reservations[0].Quantity++ }},
		{"wrong product", func(g *orderGraph) { g.reservations[0].ProductID = g.order.ID }},
		{"wrong owner item", func(g *orderGraph) { g.reservations[0].OrderItemID = g.order.ID }},
		{"wrong item order", func(g *orderGraph) { g.items[0].OrderID = g.items[0].ID }},
		{"early released", func(g *orderGraph) { g.reservations[0].Status = "released" }},
		{"wrong deadline", func(g *orderGraph) {
			g.reservations[0].ExpiresAt.Time = g.reservations[0].ExpiresAt.Time.Add(time.Second)
		}},
		{"wrong order deadline", func(g *orderGraph) { g.order.ReservationExpiresAt.Time = g.order.CreatedAt.Time }},
		{"wrong total", func(g *orderGraph) { g.order.TotalCents++ }},
		{"wrong line total", func(g *orderGraph) { g.items[0].LineTotalCents++ }},
		{"wrong currency", func(g *orderGraph) { g.order.Currency = "EUR" }},
		{"wrong payment order", func(g *orderGraph) { g.payment.OrderID = g.items[0].ID }},
		{"extra attempt", func(g *orderGraph) { g.payment.AttemptNumber = 2 }},
		{"wrong reference", func(g *orderGraph) { g.payment.SimulatorReference = "other" }},
		{"wrong scenario", func(g *orderGraph) { g.payment.Scenario = "unknown" }},
		{"invalid processing", func(g *orderGraph) { g.payment.Status = "processing" }},
		{"inconsistent terminal", func(g *orderGraph) { g.order.Status = "confirmed" }},
		{"pending with failure", func(g *orderGraph) { g.payment.FailureCode = pgtype.Text{String: "decline", Valid: true} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			graph := testGraph(t)
			tc.change(&graph)
			if !errors.Is(validateGraph(graph), ErrIntegrity) {
				t.Fatal("invalid state graph accepted")
			}
		})
	}
	for _, status := range []string{"confirmed", "payment_failed", "cancelled"} {
		graph := testGraph(t)
		graph.order.Status = status
		graph.payment.CompletedAt = pgtype.Timestamptz{Time: graph.order.CreatedAt.Time.Add(time.Second), Valid: true}
		switch status {
		case "confirmed":
			graph.payment.Status = "succeeded"
			graph.reservations[0].Status = "consumed"
			graph.payment.StartedAt = graph.order.CreatedAt
		case "payment_failed":
			graph.payment.Status = "failed"
			graph.payment.Scenario = "reject"
			graph.payment.FailureCode = pgtype.Text{String: "simulated_decline", Valid: true}
			graph.reservations[0].Status = "released"
			graph.payment.StartedAt = graph.order.CreatedAt
		case "cancelled":
			graph.payment.Status = "cancelled"
			graph.reservations[0].Status = "released"
		default:
			t.Fatal("unrecognized terminal fixture")
		}
		if err := validateGraph(graph); err != nil {
			t.Fatalf("valid %s graph rejected: %v", status, err)
		}
		graph.reservations[0].Status = "active"
		if !errors.Is(validateGraph(graph), ErrIntegrity) {
			t.Fatal("terminal order retained active hold")
		}
	}
}
