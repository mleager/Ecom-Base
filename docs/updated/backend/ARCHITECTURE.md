# Backend architecture

## Layout

One Go module (`ecom`, `go.mod` at the repository root). All backend code is under `backend/`.

| Path | Responsibility |
|---|---|
| `cmd/api` | Wires config, database pool, mail sender and handlers; runs the HTTP server with graceful shutdown |
| `cmd/reconcile` | Operator recovery CLI (logic in `internal/reconcilecmd`) |
| `cmd/fixtures` | Disposable demo database tool (logic in `internal/fixturecmd`) |
| `internal/auth` | Passwords, JWT, refresh sessions, Origin/CSRF middleware, limiters, account security |
| `internal/commerce` | Profile, addresses, catalog, admin products and inventory, carts (account and guest) |
| `internal/checkout` | T1, processing claim, simulator, T2, cancellation, orders, recovery apply, guest checkout, mailbox access |
| `internal/db/queries`, `internal/db/sqlc` | Handwritten SQL and the pgx code generated from it |
| `internal/platform/config` | Environment parsing and validation |
| `internal/platform/database` | pgx pool, session limits, readiness schema version |
| `internal/platform/email` | Standard-library SMTP sender |
| `internal/platform/httpserver`, `httpjson` | Router, middleware, health routes, strict JSON decoding, error envelope |
| `internal/platform/integration` | PostgreSQL integration tests (`-tags=integration`) |
| `migrations/` | goose SQL migrations `00001`–`00013` |

Services own their `pgx.Tx` directly. There is no repository-per-table layer.

## Dependencies

chi 5.3.1, pgx 5.10.0, golang-jwt 5.3.1, golang.org/x/crypto 0.54.0 (Argon2id). goose and sqlc are installed CLIs, not Go imports.

## Runtime limits

These values are set in code, not through environment variables.

| Setting | Value |
|---|---|
| pgx pool | max 10, min 0; connect timeout 5 s |
| PostgreSQL session | `statement_timeout` 5000 ms, `lock_timeout` 2000 ms |
| Request work | 5 s context (checkout and guest flows have their own budgets) |
| HTTP server | read-header 5 s, read 10 s, write 15 s, idle 60 s |
| Request body | 64 KiB |
| Graceful shutdown | 10 s |
| Argon2id concurrency | 2 per process |

Each process has its own pool, limiters and counters. Running more than one instance is not supported.

## HTTP surface

Base path `/api/v1`, except the root operational routes. The contract is [OpenAPI 1.7.0](../../api/openapi.yaml).

| Group | Operations | Auth |
|---|---|---|
| Operational | `GET /health/live`, `GET /health/ready`, `GET /metrics` | none; none; admin bearer |
| Auth | `POST /auth/register`, `/login`, `/refresh`, `/logout`, `/password-resets`, `/password-resets/confirm` | Origin + CSRF; login/refresh/logout use the refresh cookie |
| Profile and security | `GET/PATCH /users/me`, `GET /users/me/security`, `POST` password, email-verification (+confirm), email-change (+confirm, cancel) | Bearer; writes also need Origin + CSRF |
| Addresses | `GET/POST /users/me/addresses`, `PATCH/DELETE /users/me/addresses/{id}` | Bearer |
| Catalog | `GET /products` (optional `q`), `GET /products/{id}` | Public; active products only |
| Admin | `GET/POST /admin/products` (`q`, `is_active`), `GET/PATCH/DELETE /admin/products/{id}`, `GET/PATCH /admin/products/{id}/inventory` | Bearer; current role must be admin |
| Account cart | `GET /cart`, `POST/DELETE /cart/items`, `PATCH/DELETE /cart/items/{id}` | Bearer |
| Account checkout and orders | `POST /checkout`, `GET /orders`, `GET /orders/{id}`, `GET /orders/{id}/payments`, `POST /orders/{id}/cancel` | Bearer; checkout needs `Idempotency-Key` |
| Guest (23) | session, cart, cart-choice, checkout-intents, checkout, orders, recovery | Guest cookie (see [GUEST_COMMERCE.md](GUEST_COMMERCE.md)) |

Product retirement is `DELETE /admin/products/{id}` (a soft delete). Reactivation is `PATCH` with `is_active: true`. Stock changes are signed deltas through `PATCH .../inventory`.

## Request handling rules

- Strict JSON: unknown, duplicate or null fields are rejected; bodies over 64 KiB return 413.
- PATCH: omitted means unchanged; `null` is rejected; an empty string clears optional text; an empty PATCH is 422.
- Pagination: `limit` 1–100 (default 20), `offset` ≥ 0, array responses, no total count. Unknown or repeated query keys return 400; out-of-range values return 422.
- Sort order: products by name, then ID; orders by creation time descending, then ID.
- Cart: POST adds to an existing quantity; PATCH replaces it. Every successful write increments the cart version once. DELETE returns 204, so read the cart again for the new version.
- Responses on auth and guest routes use `Cache-Control: no-store`.
- Logs record request ID, method, status and duration. They never contain URLs with secrets, request bodies, passwords or addresses.

## Error policy

All errors use `{ "code": "...", "message": "..." }`. Stack traces and SQL errors are never exposed.

| Status | Meaning |
|---|---|
| 400 | Malformed structure, types, UUIDs or query syntax |
| 401 | Missing or invalid authentication |
| 403 | Role denied, Origin rejected, CSRF missing, or wrong current password (`reauthentication_failed`) |
| 404 | Missing or not owned. The two cases are not distinguished. |
| 409 | State or uniqueness conflict (`stale_cart`, `sku_conflict`, `cart_full`, and similar) |
| 413 | Body too large |
| 422 | Well-formed but invalid input |
| 429 | Rate limited or capacity reached; includes `Retry-After` |
| 500 | Unexpected failure, or detected data corruption |
| 503 | Dependency unavailable, or the outcome of a commit is unknown (`*_outcome_uncertain`, `*_outcome_unknown`) |

## Health and metrics

- `/health/live` returns 200 while the process can respond.
- `/health/ready` returns 200 only when PostgreSQL answers within the timeout and the goose version is exactly 13. It does not run migrations or audit grants.
- `/metrics` returns a Prometheus-format authenticated-request counter, for active admins only.

## Not present

No TLS listener, no static or SPA file serving, no background goroutines for business work, and no outbox or queue. See [../MILESTONE_14.md](../MILESTONE_14.md).
