package checkout

import (
	"context"
	"errors"
	"time"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

var ErrRecoveryIssues = errors.New("recovery found inconsistencies, failures or unresolved outcomes")
var ErrRecoveryOutput = errors.New("could not write recovery audit output")

type RecoveryOptions struct {
	Apply bool
	Limit int
}

type RecoveryFinding struct {
	Code       string `json:"code"`
	EntityType string `json:"entity_type"`
	EntityID   string `json:"entity_id"`
}

type RecoveryReport struct {
	Mode               string            `json:"mode"`
	Cutoff             time.Time         `json:"cutoff"`
	Limit              int               `json:"limit"`
	Visited            int               `json:"visited"`
	Settled            int               `json:"settled"`
	AlreadyTerminal    int               `json:"already_terminal"`
	Inconsistent       int               `json:"inconsistent"`
	Failed             int               `json:"failed"`
	Uncertain          int               `json:"uncertain"`
	DiagnosticCount    int64             `json:"diagnostic_count"`
	DiagnosticFindings []RecoveryFinding `json:"diagnostic_findings"`
}

// RecoveryEvent contains bounded audit identifiers/states, never customer data,
// credentials, SQL errors or shipping snapshots. The observer can stop a run if
// its output fails; committed claims then remain available for explicit recovery.
type RecoveryEvent struct {
	Event         string    `json:"event"`
	OrderID       string    `json:"order_id"`
	Deadline      time.Time `json:"deadline"`
	PaymentStatus string    `json:"payment_status,omitempty"`
	OrderStatus   string    `json:"order_status,omitempty"`
	Code          string    `json:"code,omitempty"`
}

func recoveryEvent(emit func(RecoveryEvent) error, event RecoveryEvent) error {
	if emit != nil {
		if err := emit(event); err != nil {
			return ErrRecoveryOutput
		}
	}
	return nil
}

// InspectRecovery captures candidates and global diagnostics in one consistent
// read-only snapshot. Its observations do not grant later processing ownership.
func (s *Service) InspectRecovery(ctx context.Context, limit int, emit func(RecoveryEvent) error) (RecoveryReport, error) {
	return s.inspectRecovery(ctx, limit, emit, true)
}

func (s *Service) inspectRecovery(ctx context.Context, limit int, emit func(RecoveryEvent) error, candidates bool) (RecoveryReport, error) {
	if limit < 1 || limit > 1000 {
		return RecoveryReport{}, ErrInvalidInput
	}

	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	report := RecoveryReport{Mode: "dry-run", Limit: limit, DiagnosticFindings: []RecoveryFinding{}}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return report, err
	}
	defer rollback(ctx, tx)

	q := db.New(tx)
	cutoff, err := q.RecoveryCutoff(ctx)
	if err != nil {
		return report, err
	}

	report.Cutoff = cutoff.Time
	if err := recoveryDiagnostics(ctx, q, &report); err != nil {
		return report, err
	}

	if !candidates {
		return report, recoveryResult(report)
	}

	orders, err := q.ReadRecoveryOrders(ctx, db.ReadRecoveryOrdersParams{Cutoff: cutoff, VisitLimit: int64(limit)})
	if err != nil {
		return report, err
	}

	for _, order := range orders {
		report.Visited++
		event := RecoveryEvent{Event: "candidate", OrderID: order.ID.String(), Deadline: order.ReservationExpiresAt.Time, OrderStatus: order.Status}
		payment, err := inspectRecoveryGraph(ctx, q, order)
		if errors.Is(err, ErrIntegrity) {
			report.Inconsistent++
			event.Event, event.Code = "inconsistent", "order_integrity"
		} else if err != nil {
			return report, err
		} else {
			event.PaymentStatus = payment.Status
		}
		if err := recoveryEvent(emit, event); err != nil {
			return report, err
		}
	}

	return report, recoveryResult(report)
}

func recoveryDiagnostics(ctx context.Context, q *db.Queries, report *RecoveryReport) error {
	findings, err := q.RecoveryDiagnostics(ctx, 100)
	if err != nil {
		return err
	}

	for _, finding := range findings {
		report.DiagnosticCount = finding.TotalFindings
		report.DiagnosticFindings = append(report.DiagnosticFindings, RecoveryFinding{Code: finding.Code, EntityType: finding.EntityType, EntityID: finding.EntityID.String()})
	}

	return nil
}

func inspectRecoveryGraph(ctx context.Context, q *db.Queries, order db.Order) (db.PaymentAttempt, error) {
	payments, err := q.ReadOrderPayments(ctx, order.ID)
	if err != nil {
		return db.PaymentAttempt{}, err
	}
	if len(payments) != 1 {
		return db.PaymentAttempt{}, ErrIntegrity
	}
	items, err := q.CheckoutOrderItems(ctx, order.ID)
	if err != nil {
		return db.PaymentAttempt{}, err
	}
	reservations, err := q.ReadOrderReservations(ctx, order.ID)
	if err != nil {
		return db.PaymentAttempt{}, err
	}
	return payments[0], validateGraph(orderGraph{order, payments[0], items, reservations})
}

func recoveryResult(report RecoveryReport) error {
	if report.DiagnosticCount > 0 || report.Inconsistent > 0 || report.Failed > 0 || report.Uncertain > 0 {
		return ErrRecoveryIssues
	}
	return nil
}

func recoveryTimestamp(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value, Valid: true}
}
