package checkout

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math"
	"strings"
	"testing"

	"ecom/backend/internal/commerce"

	"github.com/jackc/pgx/v5/pgconn"
)

const testUser = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
const testAddress = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"
const testCart = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC"

func TestIntentEncoding(t *testing.T) {
	r, err := validate(testUser, "Exact-Key!", Request{CartVersion: 42, ShippingAddressID: testAddress, PaymentScenario: "accept"})
	if err != nil {
		t.Fatal(err)
	}
	cart, err := parseID(testCart)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"user_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","cart_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","cart_version":42,"shipping_address_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","payment_scenario":"accept"}`
	if got := string(r.canonical(cart)); got != want {
		t.Fatalf("canonical intent mismatch: %s", got)
	}
	hash := sha256.Sum256([]byte(want))
	if r.fingerprint(cart) != hex.EncodeToString(hash[:]) {
		t.Fatal("fingerprint mismatch")
	}
	lockHash := sha256.Sum256([]byte("ecom:checkout:v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:Exact-Key!"))
	lock := r.lock()
	if lock.Namespace != int32(binary.BigEndian.Uint32(lockHash[:4])) || lock.Key != int32(binary.BigEndian.Uint32(lockHash[4:8])) {
		t.Fatal("advisory lock encoding mismatch")
	}
	for _, change := range []func(*validatedRequest){func(r *validatedRequest) { r.version++ }, func(r *validatedRequest) { r.scenario = "reject" }, func(r *validatedRequest) { r.address = r.user }, func(r *validatedRequest) { r.user = r.address }} {
		changed := r
		change(&changed)
		if changed.fingerprint(cart) == r.fingerprint(cart) {
			t.Fatal("changed intent retained hash")
		}
	}
	changed := r
	changed.key = "exact-key!"
	if changed.lock() == r.lock() {
		t.Fatal("key case was normalized")
	}
}

func TestRequestValidation(t *testing.T) {
	valid := Request{CartVersion: 1, ShippingAddressID: testAddress, PaymentScenario: "reject"}
	for _, key := range []string{"", strings.Repeat("a", 129), " leading", "trailing ", "a\nb", "a\tb", "é", "x\x7f"} {
		if _, err := validate(testUser, key, valid); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("key %q: %v", key, err)
		}
	}
	for _, key := range []string{"!", strings.Repeat("~", 128), "abc-123_X.Y"} {
		if _, err := validate(testUser, key, valid); err != nil {
			t.Errorf("valid key rejected: %v", err)
		}
	}
	for _, version := range []int64{0, -1, commerce.MaxCartVersion + 1, math.MaxInt64} {
		request := valid
		request.CartVersion = version
		if _, err := validate(testUser, "key", request); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("version %d: %v", version, err)
		}
	}
	for _, scenario := range []string{"", "Accept", " reject", "unknown"} {
		request := valid
		request.PaymentScenario = scenario
		if _, err := validate(testUser, "key", request); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("scenario %q: %v", scenario, err)
		}
	}
	if _, err := validate("invalid", "key", valid); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("malformed principal accepted")
	}
	request := valid
	request.ShippingAddressID = "invalid"
	if _, err := validate(testUser, "key", request); !errors.Is(err, ErrMalformedID) {
		t.Fatal("malformed address accepted")
	}
}

func TestMoneyBoundsAndIdentities(t *testing.T) {
	for _, tc := range []struct {
		price, quantity, want int64
		bad                   bool
	}{
		{1234, 2, 2468, false}, {commerce.MaxPrice, 1, commerce.MaxPrice, false}, {0, 10000, 0, false},
		{commerce.MaxPrice, 2, 0, true}, {math.MaxInt64, math.MaxInt64, 0, true}, {-1, 1, 0, true}, {1, 0, 0, true}, {1, 10001, 0, true},
	} {
		got, err := lineTotal(tc.price, tc.quantity)
		if got != tc.want || (err != nil) != tc.bad {
			t.Errorf("line %d*%d=%d err=%v", tc.price, tc.quantity, got, err)
		}
	}
	for _, tc := range []struct {
		total, line int64
		bad         bool
	}{{0, commerce.MaxPrice, false}, {commerce.MaxPrice, 0, false}, {commerce.MaxPrice, 1, true}, {math.MaxInt64, 1, true}, {-1, 1, true}, {0, -1, true}} {
		_, err := addTotal(tc.total, tc.line)
		if (err != nil) != tc.bad {
			t.Errorf("sum %+v: %v", tc, err)
		}
	}
	ids, err := newIdentities()
	if err != nil {
		t.Fatal(err)
	}
	product, err := parseID(testCart)
	if err != nil {
		t.Fatal(err)
	}
	one, err := ids.forLine(product)
	if err != nil {
		t.Fatal(err)
	}
	two, err := ids.forLine(product)
	if err != nil || one != two || one.item == one.reservation {
		t.Fatal("line identities changed during retry")
	}
	for _, id := range []string{ids.order.String(), ids.payment.String(), ids.history.String(), ids.idempotency.String(), one.item.String(), one.reservation.String()} {
		parsed, err := parseID(id)
		if err != nil || parsed.Bytes[6]>>4 != 4 || parsed.Bytes[8]>>6 != 2 {
			t.Fatal("non-v4 generated identity")
		}
	}
}

func TestRetryAndStatePolicies(t *testing.T) {
	for _, code := range []string{"40P01", "40001", "23505", "23514", "55P03", "57014", "08006"} {
		want := code == "40P01" || code == "40001"
		if retryable(&pgconn.PgError{Code: code}) != want {
			t.Fatalf("retry policy for %s", code)
		}
	}
	if retryable(errors.New("transport error")) || retryable(ErrStaleCart) || retryable(ErrInsufficientInventory) {
		t.Fatal("retried arbitrary error")
	}
	for _, order := range []string{"pending_payment", "confirmed", "payment_failed", "cancelled", "unknown"} {
		for _, payment := range []string{"pending", "processing", "succeeded", "failed", "cancelled", "unknown"} {
			want := (order == "pending_payment" && (payment == "pending" || payment == "processing")) || (order == "confirmed" && payment == "succeeded") || (order == "payment_failed" && payment == "failed") || (order == "cancelled" && payment == "cancelled")
			if consistentState(order, payment) != want {
				t.Fatalf("state pair %s/%s", order, payment)
			}
		}
	}
}
