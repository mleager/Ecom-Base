# Checkout

Checkout is where the project's reliability work is concentrated. Customers with an account and guests use the same engine.

## Guarantees

1. No committed checkout reserves more stock than is available, even with 100 concurrent buyers for the last unit.
2. One owner plus one idempotency key maps to exactly one order, permanently. Retries, double clicks and reloads can't create a second order.
3. Two different keys for the same cart version produce at most one order.
4. An `accept` result settles each reservation exactly once; a `reject` result releases each exactly once.
5. Prices, items and the shipping address are immutable snapshots taken at checkout.
6. A lost COMMIT reply is **not** treated as a rollback. The API answers "outcome unknown" instead of guessing.
7. Every crash point is recoverable: an interrupted order is settled later through the same guarded code path.

## Flow

```text
lookup key ──► found? ── yes ──► 200 original order (no new work)
     │ no
     ▼
T1      advisory lock on the key → re-check key → lock cart (version must match)
        → validate products and address → reserve stock (rows locked in product-UUID order)
        → insert order, items, reservations, pending payment, history, idempotency row
        → clear cart, version + 1 → COMMIT
     ▼
CLAIM   lock order → payment pending → processing → COMMIT
     ▼
PAY     simulated, outside any transaction; reads the persisted scenario
     ▼
T2      lock order → payment → reservations → inventory
        accept: stock consumed, order confirmed  ·  reject: stock released, order payment_failed
        → COMMIT ──► 201
```

| Design choice | Why | Trade-off accepted |
|---|---|---|
| **Two transactions with a committed claim in between**, and payment outside any transaction | No row locks are held while waiting on payment. Each crash point leaves a durable, recognisable state | More states and more code than one big transaction |
| **Look up the idempotency key before reading the cart** | T1 empties the cart, so a retry must be recognised before the cart is read | The key lookup runs on every checkout, including first attempts |
| **Fingerprint the original intent** (SHA-256 of the owner, cart, cart version, address and scenario) | The same key with a different body is detected and refused (409), not silently treated as a retry | Clients must reuse the exact original body when retrying |
| **Lock rows in one global order** (product UUID ascending) | Concurrent multi-item checkouts can't deadlock | Lock order is a rule every query must follow; it is documented in [DATABASE.md](DATABASE.md#lock-order) |
| **Deterministic simulator** (`accept` / `reject`, stored with the attempt) | Recovery re-derives the same result rather than guessing that a timed-out payment failed | Not a real payment provider; the interface is small so that a later project can make payment asynchronous |
| **Reservation deadline is a threshold, not a timer** | Nothing releases stock behind the operator's back; recovery decides with full information | Stock from an interrupted checkout stays held until `reconcile` runs. On AWS it runs every 5 minutes |

## Lost replies and uncertain outcomes

If the connection drops during a COMMIT, the server can't know whether the commit happened. The API re-reads the state on a fresh connection, under the same key lock:

| Re-read finds | Response |
|---|---|
| A settled order | 201 (or 200 for a replay) |
| A pending order | 202: committed, payment not finished |
| Nothing conclusive | 503 `checkout_outcome_uncertain`: retry with the **same** key and body |

The seven business refusals (`stale_cart`, `insufficient_inventory`, `product_unavailable`, `cart_version_exhausted`, `empty_cart`, `invalid_checkout_total`, `address_not_found`) happen before T1 commits. They therefore prove that no order exists, and the browser relies on that to decide whether it may start over ([../frontend/CHECKOUT_RECOVERY.md](../frontend/CHECKOUT_RECOVERY.md)).

## Recovery

`reconcile` finds orders still pending after the 15-minute reservation deadline. It claims each with `FOR UPDATE SKIP LOCKED` and settles it through the same T2. It never changes the scenario, invents a new attempt, force-cancels, or repairs corrupt counters; inconsistent data is reported and exits non-zero. Dry-run is the default. Two operators running it at once settle each order exactly once. On AWS, EventBridge Scheduler runs `reconcile --apply` every 5 minutes and alerts on a non-zero exit. Commands: [OPERATIONS.md](OPERATIONS.md#recover-interrupted-orders).

## State machine

Each row shows the order / payment / reservation statuses.

| From | Trigger | To |
|---|---|---|
| — | T1 commits | `pending_payment` / `pending` / `active` |
| pending | claim commits | `pending_payment` / `processing` / `active` |
| processing | T2 accept | `confirmed` / `succeeded` / `consumed` |
| processing | T2 reject | `payment_failed` / `failed` / `released` |
| pending (unclaimed) | owner cancels | `cancelled` / `cancelled` / `released` |

A repeated terminal result is a no-op, applied only after the whole order graph is validated. A rejected payment does not refill the cart; rebuilding it is a deliberate action by the shopper.

## Guest checkout

Guests can shop without an account under a separate, cookie-only namespace (`/api/v1/guest`, 23 operations). The account routes are unchanged.

| Design choice | Why | Trade-off accepted |
|---|---|---|
| **Opaque guest cookie** (32 random bytes, stored only as a SHA-256 digest; `HttpOnly`, `SameSite=Strict`, path-scoped). It expires after 7 idle days, and 30 days at most | A stolen database row can't be replayed; the idle deadline bounds abandoned sessions | A guest who clears cookies loses the cart |
| **A guest is created on the first cart action, not on browsing** | Crawlers and visitors who only browse create no rows | The first add-to-cart makes one extra call |
| **Shipping and contact details are kept on the server** in an immutable *checkout intent*. The browser keeps only its ID and key | No personal data in `localStorage` | One extra request (prepare, then place) |
| **Sign-in never merges carts.** The shopper chooses *keep account cart* or *use guest cart*, applied atomically under version checks | No surprise quantities; a late request can't overturn a confirmed choice | One extra decision for the shopper |
| **Mailbox recovery grants access to one order or intent**: a 15-minute single-use emailed proof becomes a 30-minute grant | A lost cookie can be recovered without creating an account, and the email never unlocks the whole history | Recovery covers a single target, so a shopper with several orders repeats it for each |
| **Recovery requests always return the same 202, after a fixed 8-second floor** | Response timing and content don't reveal whether an order or email exists | The request is deliberately slow |

Expired intents are scrubbed of contact and shipping data and leave a small tombstone, so a late retry can still be verified. `maintain guests` removes expired guests in batches; the runtime role can't delete guest rows itself.

## Proof

| Experiment (real PostgreSQL) | Result |
|---|---|
| 100 concurrent checkouts for 1 unit | Exactly one reservation, no negative stock |
| Retry after the cart was cleared | Same order (200); a changed address or scenario gets 409 |
| Packet faults on T1, claim, T2 and cancel COMMITs | At most one order, no double settlement, the specified 201/202/503 |
| A process killed after T1, after the claim, and during T2 | The next `reconcile` settles once; a second run changes nothing |
| Cancellation racing a claim | Exactly one wins |

Details: [TESTING.md](TESTING.md).
