# API integration

How the browser calls the API. The contract is [OpenAPI 1.7.0](../../api/openapi.yaml). The original [API_INTEGRATION.md](../../frontend/API_INTEGRATION.md) maps every operation to its screen and tests.

## Transport

- One client: `createApiClient()` in `src/shared/api/client.ts`. Responses pass runtime guards before use.
- No caching, no redirects, **no automatic retries or refreshes** in the transport itself.
- Errors are `ApiRequestError`, which separates HTTP, network, protocol and cancellation failures. It keeps the safe `{code, message}` and an integer `Retry-After`.
- A 204 has no body. Never JSON-parse it.
- Every call accepts an `AbortSignal`. Navigation and unmount abort requests, and late results are ignored.

## Credentials per call type

| Call type | Cookies | Bearer | Origin + `X-CSRF-Protection: 1` |
|---|---|---|---|
| Public catalog reads | omit | no | no |
| Register, password-reset request and confirm | omit | no | yes |
| Login, refresh, logout | include (refresh cookie) | no | yes |
| Account reads and writes | omit | yes | no |
| Authenticated security POSTs | include (so the server can clear the cookie) | yes | yes |
| Checkout | omit | yes | no; adds `Idempotency-Key` |
| Guest routes | include (guest cookies) | **never** | yes on writes |
| Cart choice | include | yes | yes |

Use `localhost` on both the frontend and the API. Mixing `localhost` and `127.0.0.1` breaks the `SameSite=Strict` cookies.

## Retry policy

| Operation | After a definitive 401 | After a network error, 500, 503 or timeout |
|---|---|---|
| Reads, and name-only profile PATCH | Refresh once, replay once for the same identity | Show an explicit Retry; no loop |
| Cart, address, admin, security, checkout and cancellation writes | **No replay** | **No replay.** Mark the outcome uncertain and block further edits until an explicit successful reread. |

A failed or lost write response is **never** treated as a rollback. Honor `Retry-After`; the UI caps advisory waits at one day.

## Status handling

| Status | UI behavior |
|---|---|
| 400 / 422 | Keep non-secret input; show the error summary; attach to a field only when the code identifies one |
| 401 | Session handling (above). Public catalog 401/403 are display errors only. |
| 403 | Role or origin denial; hide privileged content |
| 404 | Missing or not owned; one shared view |
| 409 | Explain the specific conflict; reload deliberately |
| 413 / 429 / 500 / 503 | Explain honestly; respect `Retry-After`; no retry storms |

## Data rules

- Money is integer cents, formatted as USD. Totals in the browser are estimates; checkout totals are authoritative.
- PATCH sends only changed fields. An empty string clears optional text.
- Lists use `limit` (1–100) and `offset` with no total count. A full page shows Next, which may lead to an empty page.
- Cart POST adds and PATCH replaces. Apply the returned snapshot and version. After a DELETE (204), GET the cart again; never invent a version.
- `Product.available_quantity` is the public figure. `Inventory.quantity_available` (admin) also has on-hand and reserved counts.
- `Order.payment` is optional in the contract. If it is missing, use `GET /orders/{id}/payments`.

## Search

- The header search submits explicitly. Typing alone sends nothing. Submitting resets `offset` to 0.
- `q` is trimmed (matching Go's `strings.TrimSpace`), at most 200 code points, with no NUL characters or lone surrogates.
- The URL is the state: back, forward and reload restore the search.
- Admin search uses the same parser with its own URL (`q`, `is_active`, `limit` 20/50/100, `offset`).

## Cart enrichment

Cart lines contain only item ID, product ID and quantity. The cart page fetches product details itself:

- At most 100 distinct products, **4 concurrent requests**, one attempt per product per load, and a **10 s** overall deadline.
- A 404 means unavailable: show the ID and quantity with an image fallback, and keep Remove working.
- Failed or slow reads leave the line unpriced. Retry product details is an explicit action.
- Show a subtotal only when every line has a price and the checked arithmetic stays within 1,000,000,000,000 cents. Never treat a missing price as zero.

## Timeouts

| Request | Deadline |
|---|---|
| Catalog and product reads | 10 s |
| Cookie operations, including the lock wait | 20 s |
| Feature reads and writes (profile, address, cart, admin) | 20 s |
| Lock acquisition (checkout, cart) | 5 s |
| Guest preparation / checkout POST | 10 s / 30 s |
| Order status read | 10 s |

## Order observation

Pending orders are polled only on the order page that is open:

- Polls run 3 s after each read finishes, one at a time, for at most **60 s or 20 reads**.
- Polling stops on a terminal state, an error, navigation, an identity change or a hidden tab.
- Manual **Check Status** makes one bounded read and does not restart polling.
- Pending is not failure. A timeout is not rejection.

## Cancellation

The UI asks for confirmation, then sends once with no body.

| Result | UI |
|---|---|
| 200 | Show the cancelled order |
| 409 `cancellation_conflict` | Read the order again and explain |
| 503 `order_outcome_uncertain`, or a lost reply | Read the same order; offer only an explicit retry for that order |

Checkout response handling is in [CHECKOUT_RECOVERY.md](CHECKOUT_RECOVERY.md).
