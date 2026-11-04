package checkout

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"

	"ecom/backend/internal/commerce"
	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5/pgtype"
)

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

type validatedRequest struct {
	user, address      pgtype.UUID
	guest, guestIntent pgtype.UUID
	guestPayload       []byte
	contactEmail       pgtype.Text
	key, scenario      string
	version            int64
}

func validate(userID, key string, input Request) (validatedRequest, error) {
	user, err := parseID(userID)
	if err != nil {
		return validatedRequest{}, ErrUnauthorized
	}

	address, err := parseID(input.ShippingAddressID)
	if err != nil {
		return validatedRequest{}, err
	}

	if len(key) < 1 || len(key) > 128 {
		return validatedRequest{}, ErrInvalidKey
	}

	for i := range len(key) {
		if key[i] < 0x21 || key[i] > 0x7e {
			return validatedRequest{}, ErrInvalidKey
		}
	}

	if input.CartVersion < 1 || input.CartVersion > commerce.MaxCartVersion || (input.PaymentScenario != "accept" && input.PaymentScenario != "reject") {
		return validatedRequest{}, ErrInvalidInput
	}

	return validatedRequest{user: user, address: address, key: key, scenario: input.PaymentScenario, version: input.CartVersion}, nil
}

type intent struct {
	UserID            string `json:"user_id"`
	CartID            string `json:"cart_id"`
	CartVersion       int64  `json:"cart_version"`
	ShippingAddressID string `json:"shipping_address_id"`
	PaymentScenario   string `json:"payment_scenario"`
}

func (r validatedRequest) canonical(cart pgtype.UUID) []byte {
	// This fixed-order structure contains only strings and int64, so Marshal
	// cannot encounter unsupported values or nonfinite numbers.
	encoded, _ := json.Marshal(intent{r.user.String(), cart.String(), r.version, r.address.String(), r.scenario})
	return encoded
}

func (r validatedRequest) fingerprint(cart pgtype.UUID) string {
	if r.guest.Valid {
		canonical, _ := json.Marshal(struct {
			GuestID, CartID, IntentID, Scenario, Payload string
			Version                                      int64
		}{r.guest.String(), cart.String(), r.guestIntent.String(), r.scenario, hex.EncodeToString(r.guestPayload), r.version})
		hash := sha256.Sum256(append([]byte("ecom:guest-checkout:v1:"), canonical...))
		return hex.EncodeToString(hash[:])
	}
	hash := sha256.Sum256(r.canonical(cart))
	return hex.EncodeToString(hash[:])
}

func (r validatedRequest) lock() db.LockCheckoutKeyParams {
	namespace, owner := "ecom:checkout:v1:", r.user
	if r.guest.Valid {
		namespace, owner = "ecom:guest-checkout:v1:", r.guest
	}
	hash := sha256.Sum256([]byte(namespace + owner.String() + ":" + r.key))
	return db.LockCheckoutKeyParams{Namespace: int32(binary.BigEndian.Uint32(hash[0:4])), Key: int32(binary.BigEndian.Uint32(hash[4:8]))}
}

func lineTotal(price, quantity int64) (int64, error) {
	if price < 0 || price > commerce.MaxPrice || quantity < 1 || quantity > commerce.MaxQuantity {
		return 0, ErrInvalidTotal
	}

	if price > commerce.MaxPrice/quantity {
		return 0, ErrInvalidTotal
	}

	return price * quantity, nil
}

func addTotal(total, line int64) (int64, error) {
	if total < 0 || line < 0 || line > commerce.MaxPrice || total > commerce.MaxPrice-line {
		return 0, ErrInvalidTotal
	}
	return total + line, nil
}

type lineIDs struct {
	item, reservation pgtype.UUID
}

type identities struct {
	order, payment, history, idempotency pgtype.UUID
	lines                                map[pgtype.UUID]lineIDs
}

func newIdentities() (*identities, error) {
	ids := &identities{lines: make(map[pgtype.UUID]lineIDs)}
	for _, field := range []*pgtype.UUID{&ids.order, &ids.payment, &ids.history, &ids.idempotency} {
		id, err := newID()
		if err != nil {
			return nil, err
		}
		*field = id
	}

	return ids, nil
}

func (ids *identities) forLine(product pgtype.UUID) (lineIDs, error) {
	if existing, ok := ids.lines[product]; ok {
		return existing, nil
	}

	item, err := newID()
	if err != nil {
		return lineIDs{}, err
	}

	reservation, err := newID()
	if err != nil {
		return lineIDs{}, err
	}

	result := lineIDs{item, reservation}
	ids.lines[product] = result

	return result, nil
}
