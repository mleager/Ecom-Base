# Checkout

How an order is created, paid (simulated), cancelled and recovered. Account and guest orders share the same engine. Guest-specific setup is in [GUEST_COMMERCE.md](GUEST_COMMERCE.md).

## Guarantees

1. No committed checkout reserves more than the available stock.
2. An `accept` result settles each reservation exactly once; a `reject` result releases each exactly once.
3. Prices, items and the shipping address are immutable server snapshots.
4. One owner plus idempotency key maps to one order, permanently.
5. Different keys for the same cart version produce at most one order.
6. A rolled-back T1 leaves nothing behind. A lost COMMIT reply is **not** proof of rollback.
7. Recovery never guesses that a timed-out payment was rejected. It re-derives the deterministic result.

## Request

`POST /api/v1/checkout` (bearer auth)

- Header `Idempotency-Key`: 1–128 visible ASCII characters, case-sensitive. The browser uses a UUIDv4.
- Body: `cart_version` (positive safe integer), `shipping_address_id` (owned), `payment_scenario` (`accept` or `reject`).

**Fingerprint:** SHA-256 of compact JSON with the fields in fixed order `user_id, cart_id, cart_version, shipping_address_id, payment_scenario`, stored as lowercase hex. Guests use a separate versioned fingerprint (see the guest document).

**Retry rule:** look up the key **before** reading the mutable cart. The same key with the same intent returns the original order (200) with no new processing. The same key with a different intent returns 409 `idempotency_conflict`. Cart clearing or later address and product edits do not affect a retry.

## Flow

```text
lookup key ──► found? ── yes ──► 200 original order (observe only)
     │ no
     ▼
T1  advisory key lock → re-check key → lock cart (version must match, cart not empty)
    → validate active products and owned address → reserve inventory in product-UUID order
    → insert order, items, reservations, payment attempt (pending), history, idempotency
    → clear cart items, version + 1 → COMMIT
     ▼
CLAIM  lock order → payment pending → processing → COMMIT
     ▼
SIMULATE  outside any transaction; reads the persisted attempt ID and scenario
     ▼
T2  lock order → attempt → reservations → inventory
    accept: on-hand − n, reserved − n, reservations consumed, payment succeeded, order confirmed
    reject: reserved − n, reservations released, payment failed, order payment_failed
    → append history → COMMIT ──► 201
```

If processing is interrupted after T1 and a reply can still be sent, a bounded fresh read returns 202 (pending is known), 201 (terminal is known) or 503 (unresolved). A process crash may send no reply. Pending orders are left for the recovery CLI.

**Advisory lock key:** SHA-256 of `ecom:checkout:v1:<user-uuid>:<key>`. The first two 4-byte words, read as big-endian signed int32 values, are passed to `pg_advisory_xact_lock(int, int)`. The unique constraint is still the final authority; a digest collision only serializes unrelated requests.

## State machine

Statuses are shown as order / payment / reservation.

| From | Trigger | To |
|---|---|---|
| — | T1 commits | `pending_payment` / `pending` / `active` |
| pending | claim commits | `pending_payment` / `processing` / `active` |
| processing | T2 accept | `confirmed` / `succeeded` / `consumed` |
| processing | T2 reject | `payment_failed` / `failed` / `released` |
| pending (not processing) | owner cancels | `cancelled` / `cancelled` / `released` |
| terminal | matching finalize or repeat cancel | unchanged (no-op after graph validation) |

Payment transitions are forbidden out of any terminal state. Rejection does **not** refill the cart.

## Cancellation

`POST /orders/{id}/cancel` (no body). Allowed only for the owner, and only while the order is `pending_payment` with payment `pending`. Once processing is claimed, cancellation returns 409 until recovery finishes. Repeat cancellation returns the cancelled order. Confirmed and failed orders cannot be cancelled. There are no refunds.

A lost COMMIT reply leads to a bounded re-read: a known cancelled order returns 200; otherwise 503 `order_outcome_uncertain`. Retry cancellation for the same order.

## Responses

| Condition | Status / code |
|---|---|
| New order settled (accepted, rejected, or cancelled concurrently) | 201. A 201 does not mean the payment succeeded. |
| New order committed, processing interrupted | 202 |
| Same key, same intent | 200 |
| Same key, different intent | 409 `idempotency_conflict` |
| Cart version stale or already used | 409 `stale_cart` |
| Not enough stock | 409 `insufficient_inventory` |
| Inactive product in cart | 409 `product_unavailable` |
| Cart version at its maximum | 409 `cart_version_exhausted` |
| Empty cart | 422 `empty_cart` |
| Total over the limit | 422 `invalid_checkout_total` |
| Address missing or not owned | 404 `address_not_found` |
| Outcome of T1, claim or T2 COMMIT unknown | 503 `checkout_outcome_uncertain`; retry with the identical key and body |
| Data corruption detected | 500; no repair, and committed T1 data is kept |

The seven 409/422/404 business refusals above happen after the key lock and before T1 commits, so they prove no order exists for that key. The browser relies on this list. See [../frontend/CHECKOUT_RECOVERY.md](../frontend/CHECKOUT_RECOVERY.md).

## Expiry and recovery

The reservation deadline is order creation + 15 minutes. It is a threshold for recovery, **not** a timer that releases stock. Nothing runs automatically. An operator runs the recovery CLI, which claims or resumes expired pending orders and settles them through the same guarded T2. An `accept` scenario is still confirmed after expiry. See [OPERATIONS.md](OPERATIONS.md#recover-interrupted-orders).

## Simulator

The simulator reads the persisted `payment_attempts.scenario` and attempt ID. `accept` always succeeds and `reject` always fails, however many times it is called. Faults (interrupt after T1, before T2, process crash) are injected only by the test harness, never through the API.

## Boundary with Project 7

Project 1 has no outbox, queue, webhook or payment worker. The simulator and settlement sit behind small interfaces so Project 7 can replace synchronous execution with durable asynchronous processing.
