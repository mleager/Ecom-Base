// Package commerce implements the account, catalog and cart use cases. SQL lives
// in sqlc queries; transaction boundaries and validation live in these services.
package commerce

import (
	"context"
	"crypto/rand"
	"errors"
	randv2 "math/rand/v2"
	"strings"
	"time"
	"unicode/utf8"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	MaxPrice       int64 = 1_000_000_000_000
	MaxStock       int64 = 2_147_483_647
	MaxCartVersion int64 = 9_007_199_254_740_991
	MaxQuantity    int64 = 10_000
	MaxCartItems         = 100
)

var (
	ErrInvalidInput     = errors.New("invalid input")
	ErrMalformedID      = errors.New("malformed UUID")
	ErrNotFound         = errors.New("resource not found")
	ErrSKUConflict      = errors.New("SKU already exists")
	ErrStockConflict    = errors.New("stock adjustment conflicts with stock bounds or reservations")
	ErrCartFull         = errors.New("cart contains maximum distinct products")
	ErrVersionExhausted = errors.New("cart version exhausted")
)

type Service struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool, queries: db.New(pool)} }

func parseID(raw string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if len(raw) != 36 || raw[8] != '-' || raw[13] != '-' || raw[18] != '-' || raw[23] != '-' || id.Scan(raw) != nil || !id.Valid {
		return pgtype.UUID{}, ErrMalformedID
	}
	return id, nil
}

func newID() (pgtype.UUID, error) {
	id := pgtype.UUID{Valid: true}
	if _, err := rand.Read(id.Bytes[:]); err != nil {
		return pgtype.UUID{}, err
	}

	id.Bytes[6] = (id.Bytes[6] & 0x0f) | 0x40
	id.Bytes[8] = (id.Bytes[8] & 0x3f) | 0x80

	return id, nil
}

func idString(id pgtype.UUID) string { return id.String() }

// normalizeText distinguishes omitted fields from explicitly empty optional text.
func normalizeText(value *string, maximum int, required bool) bool {
	if value == nil {
		return true
	}
	*value = strings.TrimSpace(*value)

	return utf8.ValidString(*value) && !strings.ContainsRune(*value, 0) && utf8.RuneCountInString(*value) <= maximum && (!required || *value != "")
}

func text(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func optionalText(value *string) pgtype.Text {
	if value == nil || *value == "" {
		return pgtype.Text{}
	}
	return text(value)
}

func found(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func skuError(err error) error {
	var pgError *pgconn.PgError
	if errors.As(err, &pgError) && pgError.Code == "23505" && pgError.ConstraintName == "products_sku_key" {
		return ErrSKUConflict
	}
	return found(err)
}

// Only PostgreSQL-confirmed aborted transactions are retryable. Transport and
// COMMIT acknowledgement errors are returned without replaying a mutation.
func transact[T any](ctx context.Context, pool *pgxpool.Pool, work func(*db.Queries) (T, error)) (T, error) {
	var zero T
	for attempt := 0; attempt < 3; attempt++ {
		result, err := transaction(ctx, pool, work)
		var pgError *pgconn.PgError
		if err == nil || !errors.As(err, &pgError) || (pgError.Code != "40P01" && pgError.Code != "40001") || attempt == 2 {
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

	return zero, errors.New("transaction retry budget exhausted")
}

func transaction[T any](ctx context.Context, pool *pgxpool.Pool, work func(*db.Queries) (T, error)) (T, error) {
	var zero T
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return zero, err
	}

	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()

	result, err := work(db.New(tx))
	if err != nil {
		return zero, err
	}

	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}

	return result, nil
}
