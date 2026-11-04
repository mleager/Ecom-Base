// Package checkout owns transactional order creation, processing, settlement,
// cancellation and their HTTP boundary. The simulator has no external side effect.
package checkout

import (
	"errors"
	"time"
)

var (
	ErrInvalidInput          = errors.New("invalid checkout input")
	ErrMalformedID           = errors.New("malformed checkout UUID")
	ErrInvalidKey            = errors.New("invalid idempotency key")
	ErrUnauthorized          = errors.New("active authenticated customer required")
	ErrIdempotencyConflict   = errors.New("idempotency_conflict")
	ErrStaleCart             = errors.New("stale_cart")
	ErrEmptyCart             = errors.New("empty_cart")
	ErrAddressNotFound       = errors.New("address_not_found")
	ErrProductUnavailable    = errors.New("product_unavailable")
	ErrInsufficientInventory = errors.New("insufficient_inventory")
	ErrInvalidTotal          = errors.New("invalid_checkout_total")
	ErrVersionExhausted      = errors.New("cart_version_exhausted")
	ErrIntegrity             = errors.New("checkout data integrity failure")
	ErrOutcomeUncertain      = errors.New("checkout_outcome_uncertain")
	ErrOrderNotFound         = errors.New("order_not_found")
	ErrProcessingInProgress  = errors.New("payment_processing")
	ErrSettlementConflict    = errors.New("settlement_conflict")
	ErrCancellationConflict  = errors.New("cancellation_conflict")
	ErrOrderOutcomeUncertain = errors.New("order_outcome_uncertain")
)

type Request struct {
	CartVersion       int64  `json:"cart_version"`
	ShippingAddressID string `json:"shipping_address_id"`
	PaymentScenario   string `json:"payment_scenario"`
}

type ShippingAddress struct {
	Label         string `json:"label,omitempty"`
	RecipientName string `json:"recipient_name"`
	Line1         string `json:"line_1"`
	Line2         string `json:"line_2,omitempty"`
	City          string `json:"city"`
	Region        string `json:"region"`
	PostalCode    string `json:"postal_code"`
	CountryCode   string `json:"country_code"`
}

type Item struct {
	ID             string `json:"id"`
	ProductID      string `json:"product_id"`
	SKU            string `json:"sku_snapshot"`
	Name           string `json:"product_name_snapshot"`
	Quantity       int32  `json:"quantity"`
	UnitPriceCents int64  `json:"unit_price_cents"`
	LineTotalCents int64  `json:"line_total_cents"`
}

type Payment struct {
	ID          string    `json:"id"`
	Status      string    `json:"status"`
	FailureCode *string   `json:"failure_code"`
	CreatedAt   time.Time `json:"created_at"`
}

type Order struct {
	ID              string          `json:"id"`
	Status          string          `json:"status"`
	TotalCents      int64           `json:"total_cents"`
	Currency        string          `json:"currency"`
	ShippingAddress ShippingAddress `json:"shipping_address"`
	Items           []Item          `json:"items"`
	Payment         Payment         `json:"payment"`
	CreatedAt       time.Time       `json:"created_at"`
}

// Replayed means this is a retained result, including a result found after a lost
// commit acknowledgement. Such results must not trigger payment processing.
type Result struct {
	Order       Order
	Replayed    bool
	Interrupted bool
}
