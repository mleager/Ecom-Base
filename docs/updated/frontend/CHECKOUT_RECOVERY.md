# Checkout recovery (browser)

How the browser makes checkout safe across double clicks, lost replies, reloads, tab crashes and identity changes. The server side is described in [../backend/CHECKOUT.md](../backend/CHECKOUT.md). The full specification is in [CHECKOUT_RECOVERY_DESIGN.md](../../frontend/CHECKOUT_RECOVERY_DESIGN.md).

## Core rule

**Save before sending, and send once.** The browser writes the original idempotency key and request body to localStorage, reads them back, and only then sends one POST. After any uncertain result, the only way forward is an explicit **Resume Original Checkout**, which reuses the exact same key and body.

## Records

One slot per owner and API base. The storage key and the Web Lock name are the same.

| Owner | Key |
|---|---|
| Account (v1) | `commerce-lab:checkout:<encoded-api-base>:<user-id>` |
| Guest (v2) | `commerce-lab:checkout:<encoded-api-base>:guest:<guest-id>:v2` |
| Guest hint | `commerce-lab:guest-checkout-hint:<encoded-api-base>` (no key, no personal data) |

**v1 fields, in order:** `schema_version: 1`, `user_id`, `idempotency_key` (UUIDv4), `request {cart_version, shipping_address_id, payment_scenario}`, `created_at`, `phase`, `generation`, `revision`, and `order_id` (only when `phase` is `known_order`).

**v2** replaces the address with `checkout_intent_id`, and adds `owner_kind: "guest"` and the `preparing` phase. Shipping and contact stay on the server.

Records are canonical JSON of at most 4096 bytes. Anything malformed, unknown or oversized is **kept unchanged and blocks checkout**. It is never repaired or deleted automatically. Records never hold credentials, full addresses, cart contents, prices or payment results.

## Phases

| Phase | Meaning |
|---|---|
| `preparing` (guest) | Saved; the server intent may or may not exist yet |
| `unresolved` | Saved and possibly sent. The outcome is unknown. |
| `known_order` | The server returned a valid order. This is the durable handoff. |
| `rejected` | A verified business refusal proved that no order exists for this key |

## Coordination

- Web Locks **and** BroadcastChannel are required. If either is unavailable, checkout is blocked.
- Lock acquisition has 5 s. Under the lock, the record is read and validated again, then identity and page lifetime are rechecked. The lock is held through the POST (30 s) and the result write.
- The lock is released before order reads, cart refresh or polling.
- Auth and checkout locks are never nested. If the session needs renewal, the checkout lock is released and the user must act again.
- Broadcasts carry only the string `changed`. Receivers reread under the lock.
- Every update must match owner, key, generation and revision. A stale callback can never overwrite, delete or resurrect a record.

## Outcome handling

| Result | Action |
|---|---|
| 201 / 200 / 202 with a valid order | Write `known_order` with the order ID, read it back, release the lock. Then show the order and refresh the cart. |
| 500, 503, timeout, lost or malformed reply | Keep `unresolved` and block new checkouts. Offer **Resume Original Checkout**. |
| 401 or 403 | Keep the record. Handle auth outside checkout. Never replay the write. |
| 409 `idempotency_conflict` | Keep the record and block. Never change the key or body. |
| Verified refusal (exact status and code) | Write `rejected`, then offer **Retire rejected checkout and review again** |
| Any other 400, 413 or 422 | Keep the record. An early refusal does not resolve an earlier uncertain attempt. |

**Verified refusals** (they happen after the server's key lock, so no order exists): 409 `stale_cart`, `insufficient_inventory`, `product_unavailable`, `cart_version_exhausted`; 404 `address_not_found` (account only); 422 `empty_cart`, `invalid_checkout_total`. Guests also have `checkout_intent_expired` and `checkout_intent_retired`, but only with a verified closed-intent receipt.

The error body must match exactly: JSON with only `code` and `message`, the expected status, and bounded lengths. Otherwise the result is treated as uncertain.

## Handoff and replacement

- `known_order` is kept until a new, freshly reviewed checkout replaces it. It is not erased when the order reaches a terminal state, and failed reads keep it.
- After the handoff, a cart refresh must return a version **newer** than the one consumed. Until then, a new checkout is blocked.
- A new checkout always needs a fresh cart read, a fresh review and new choices.
- A `rejected` record must be explicitly retired (removed, then confirmed absent) before a new review. Retiring sends no checkout and creates no key.

## What the user sees

Before Resume, the UI explains that the request may find an existing order or submit the original request. It uses the same key and body, current prices still apply, and interrupted payment processing will not restart.

## Limits

- Clearing browser data, or switching browser or device, loses the record. Order history is still available, but the exact submission cannot be identified. The app never guesses by matching timestamps or totals.
- localStorage is not confidential from same-origin scripts or someone with access to the browser profile.
- Guests who lose their cookie can use mailbox recovery for one order or intent. See [../backend/GUEST_COMMERCE.md](../backend/GUEST_COMMERCE.md#mailbox-recovery).
