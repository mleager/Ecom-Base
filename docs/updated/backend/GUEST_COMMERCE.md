# Guest commerce

Guests can build a cart, check out and view orders without an account. Account routes and DTOs are unchanged; guests use a separate cookie-only namespace, `/api/v1/guest`. The full design, with every edge case, is in [GUEST_COMMERCE_DESIGN.md](../../backend/GUEST_COMMERCE_DESIGN.md).

## Identity

- A guest is a UUID principal with one server cart. It has no password, profile, role or address book. The UUID is an identifier, not authorization.
- **Full guest cookie** `ecom_guest`: 32 random bytes, stored as a SHA-256 verifier. Host-only, `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/guest`, `Secure` in production. Fixed **30-day** expiry, never extended.
- **Recovery cookie** `ecom_guest_recovery`: a **30-minute** grant for exactly one checkout intent or one order. It cannot read the cart or order history.
- Browsing creates nothing. A guest is created on the first deliberate guest cart action, and only after account restoration has definitely found no signed-in user.
- Every guest POST, PATCH and DELETE needs the exact Origin and `X-CSRF-Protection: 1`. Guest routes reject bearer tokens and duplicate cookies.

## Endpoints (23)

| Area | Operations |
|---|---|
| Session | `GET`/`POST`/`DELETE /guest/session`, `POST /guest/session/rotate` |
| Cart | `GET /guest/cart`, `POST`/`DELETE /guest/cart/items`, `PATCH`/`DELETE /guest/cart/items/{id}` (same rules as the account cart) |
| Cart choice | `GET`/`POST /guest/cart-choice` (needs bearer **and** guest cookie) |
| Checkout | `POST /guest/checkout-intents`, `GET /guest/checkout-intents/{id}`, `POST .../{id}/retire`, `POST /guest/checkout` |
| Orders | `GET /guest/orders`, `GET /guest/orders/{id}`, `GET .../{id}/payments`, `POST .../{id}/cancel` |
| Recovery | `POST /guest/recovery-requests`, `POST /guest/recovery-confirmations`, `GET`/`DELETE /guest/recovery-access` |

`GET /guest/session` only verifies the cookie. `POST` creates a guest (201) or returns the existing valid one (200). An invalid cookie returns 401 and is never silently replaced.

## Signing in with a guest cart

Login never adopts a guest cart or guest orders. If the guest cart is not empty, the shopper must choose:

- `keep_account`: record the choice and leave both carts unchanged.
- `use_guest`: atomically **replace** the account cart with the guest lines, clear the guest cart, and increment both versions. Quantities are not merged and stock is not reserved.

Both expected versions are checked under locks. A mismatch returns 409 `cart_choice_conflict`. An unresolved guest checkout blocks `use_guest` with 409 `guest_checkout_unresolved`. The receipt is stored per account session and guest. Only an identical resubmission can repeat it, so a late `use_guest` cannot overturn a confirmed `keep_account`.

## Checkout

Guest shipping and contact details are kept **on the server** so they never enter browser storage.

1. **Prepare:** `POST /guest/checkout-intents` with the `Idempotency-Key` and `{id, cart_version, payment_scenario, contact_email, shipping_address}`. This stores an immutable intent and creates no order, hold or payment. It returns 201 on the first call, 200 for an identical repeat, and 409 for a different body with the same key.
2. **Place:** `POST /guest/checkout` with the same key and `{cart_version, checkout_intent_id, payment_scenario}`. This runs the shared T1 → claim → simulate → T2 path. Prices and stock are checked at T1, not at preparation.
3. **Retire:** `POST .../{id}/retire` with the original key. It returns the order if one committed. Otherwise it closes the intent, or writes a tombstone if the intent never arrived, so a late request cannot bring it back.

Shipping is US only: `recipient_name`, `line_1`, optional `line_2`, `city`, `region`, `postal_code`, and `country_code: US`. It uses the same validation as account addresses.

Intents last **30 days**. On expiry, any committed order is still found first. Otherwise the intent closes and its plaintext contact and shipping are scrubbed. A small tombstone (ID, key, hashes, an email digest) remains so retries can still be verified.

Guest-specific codes: 409 `checkout_intent_expired` or `checkout_intent_retired`, 404 `checkout_intent_not_found`. The business refusals from [CHECKOUT.md](CHECKOUT.md#responses) are recorded as a closed rejection only after confirming that no order committed.

## Mailbox recovery

A lost guest cookie cannot be restored by email. A shopper can recover access to **one** target:

1. `POST /guest/recovery-requests` with `contact_email` and exactly one of `checkout_intent_id` or `order_id`. It always returns the same 202, with an 8-second response floor.
2. If the target exists and the email matches, a 15-minute single-use proof is mailed to `/guest/recover#token=…`. At most 3 proofs are live per target.
3. `POST /guest/recovery-confirmations` consumes the proof and sets `ecom_guest_recovery`.

| Grant scope | Allows |
|---|---|
| `order` | That order's details, payments and eligible cancellation |
| `checkout_intent` | Reading and retiring that intent, its original same-key checkout, and the resulting order |

A grant never logs anyone in, replaces the full guest cookie, reads the cart or history, or covers other orders that share the email.

## Limits

These are single-process budgets, not distributed quotas.

| Action | Limit |
|---|---|
| Create a guest | 5/peer/hour; at most 10,000 live guest sessions |
| Reads | 120/peer/min |
| Writes | 30/peer/min and 30/guest/min |
| Rotate | 5/guest/hour |
| Prepare | 5/guest/hour; 1 prepared intent per guest; at most 100 intents or tombstones per guest |
| Recovery mail | 20/peer/min, and 3/hour per email and target |
| Recovery redemption | 20/peer/min, and 5/min per token |

## Timeouts (browser and server)

Lock acquisition 5 s; prepare 10 s; checkout 30 s; one combined action at most 40 s; other writes 20 s; reads 10 s.

## Lock order

guest principal → scoped grant (if used) → owner/key → intent → cart → inventory by product UUID. Cancellation takes the principal and grant, then enters the shared order → payment → reservations → inventory sequence.

## Maintenance

The runtime role cannot delete guest rows. As an operator, prune sessions, proofs and grants at least 7 days after expiry, in batches of 500 rows with 5 s transactions. Expire overdue intents through the same scrub path. Guest down-migrations refuse to run if data would be lost.
