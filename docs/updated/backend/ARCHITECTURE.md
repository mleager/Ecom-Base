# Backend architecture

## Layout

One Go module (`ecom`, `go.mod` at the repository root). All backend code is under `backend/`.

| Path | Responsibility |
|---|---|
| `cmd/api` | Wires config, telemetry, database pool, business metrics, mail sender and handlers; runs the HTTP server with graceful shutdown |
| `cmd/migrate` | Forward-only migration job with the SQL embedded: `up` and read-only `status` (logic in `internal/migratecmd`, files from `backend/embed.go`) |
| `cmd/reconcile` | Operator recovery CLI (logic in `internal/reconcilecmd`) |
| `cmd/fixtures` | Disposable demo database tool (logic in `internal/fixturecmd`) |
| `internal/auth` | Passwords, JWT, refresh sessions, Origin/CSRF middleware, limiters, account security |
| `internal/commerce` | Profile, addresses, catalog, admin products and inventory, carts (account and guest) |
| `internal/checkout` | T1, processing claim, simulator, T2, cancellation, orders, recovery apply, guest checkout, mailbox access |
| `internal/db/queries`, `internal/db/sqlc` | Handwritten SQL and the pgx code generated from it |
| `internal/platform/config` | Environment parsing and validation |
| `internal/platform/database` | pgx pool, session limits, minimum schema version for readiness; query spans and pool metrics |
| `internal/platform/email` | Standard-library SMTP sender; `smtp send` spans and delivery counts |
| `internal/platform/httpserver`, `httpjson` | Router, middleware, health routes, TLS and HSTS, optional static SPA serving, strict JSON decoding, error envelope; HTTP server spans and request metrics |
| `internal/platform/telemetry` | OpenTelemetry providers, OTLP trace export, the `METRICS_ADDR` Prometheus listener, trace IDs in logs |
| `internal/platform/metrics` | Business counters (orders, payments, unknown outcomes, guest sessions, rate limits, mail) |
| `internal/platform/integration` | PostgreSQL integration tests (`-tags=integration`) |
| `migrations/` | goose SQL migrations `00001`–`00013` |

Services own their `pgx.Tx` directly. There is no repository-per-table layer.

## Dependencies

chi 5.3.1, pgx 5.10.0, golang-jwt 5.3.1, golang.org/x/crypto 0.58.0 (Argon2id). Telemetry (M15): OpenTelemetry Go 1.47.0 (API, SDK, metric SDK, OTLP/HTTP trace exporter), the OpenTelemetry Prometheus exporter 0.69.0 and `prometheus/client_golang` 1.25.0. goose 3.28.0 is a Go import of `cmd/migrate` only (M16); the goose CLI and sqlc stay installed development tools.

## Runtime limits

These values are set in code, not through environment variables (except the pool size, which pgx reads from `DATABASE_URL`).

| Setting | Value |
|---|---|
| pgx pool | max 10, min 0 unless `DATABASE_URL` sets `pool_max_conns` or `pool_min_conns`; connect timeout 5 s |
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
- Logs record request ID, method, status and duration, plus `trace_id` and `span_id` when tracing is on. They never contain URLs with secrets, request bodies, passwords or addresses.
- A request whose client disconnected before the handler finished (closed connection or HTTP/2 stream reset) is logged with `status` 499, `client_closed: true` and the `handler_status` the handler wrote. Handlers often map the resulting `context.Canceled` to 500 or 503, but no client receives it. Handler timeouts use derived contexts and keep their real status.

## Error policy

All errors use `{ "code": "...", "message": "..." }`. Stack traces and SQL errors are never exposed.

| Status | Meaning |
|---|---|
| 400 | Malformed structure, types, UUIDs or query syntax |
| 401 | Missing or invalid authentication |
| 403 | Role denied, Origin rejected, CSRF missing, or wrong current password (`reauthentication_failed`) |
| 404 | Missing or not owned. The two cases are not distinguished. Also any unknown path under `/api/v1`, whatever the method. |
| 405 | A real route called with the wrong method |
| 409 | State or uniqueness conflict (`stale_cart`, `sku_conflict`, `cart_full`, and similar) |
| 413 | Body too large |
| 422 | Well-formed but invalid input |
| 429 | Rate limited or capacity reached; includes `Retry-After` |
| 500 | Unexpected failure, or detected data corruption |
| 503 | Dependency unavailable, or the outcome of a commit is unknown (`*_outcome_uncertain`, `*_outcome_unknown`) |

## Health and metrics

- `/health/live` returns 200 while the process can respond.
- `/health/ready` returns 200 only when PostgreSQL answers within the timeout and the applied goose version is at least `database.MinSchemaVersion` (13). A newer schema passes, so an expand migration can run before the API that needs it. It does not run migrations or audit grants.
- `/metrics` returns a Prometheus-format authenticated-request counter, for active admins only.

## Telemetry

Built in since Milestone 15 and off unless configured ([OPERATIONS.md](OPERATIONS.md#telemetry-optional)). Every name it emits is in [OBSERVABILITY_CONTRACT.md](OBSERVABILITY_CONTRACT.md).

- `platform/telemetry` builds the tracer and meter providers once in `main.go`. With nothing set they are no-ops, and the code that uses them has no special cases.
- Traces: the `httpserver` middleware starts a server span per request (not `/health/*` or `/metrics`) and names it by the chi route pattern after routing. pgx calls the database tracer for each query, which adds a child span with the statement text but never the arguments. The instrumented mail sender adds an `smtp send` span. Spans leave in batches over OTLP/HTTP, off the request path.
- Metrics: request duration and in-flight requests, query duration, pool state and acquire waits, and the business counters in `platform/metrics`, passed explicitly to auth, the guest handlers, checkout and the mail sender. A separate plain-HTTP listener on `METRICS_ADDR` serves them with Go runtime and process metrics.
- Logs: `telemetry.LogHandler` wraps the JSON handler and adds `trace_id` and `span_id` to lines logged inside a traced request.
- Labels are bounded: route patterns with fixed `static` and `unmatched` values, fixed outcome words, and limiter names set in code. No user, order, product or session ID becomes a label.

## Static frontend (optional)

When `STATIC_DIR` is set, the API also serves the built frontend from the same origin. Startup fails if the directory has no `index.html`.

- Matching order: API routes under `/api/`, then `/health/*` and `/metrics`, then files in `STATIC_DIR`, then `index.html`.
- `index.html` is the fallback only for `GET` and `HEAD` requests whose path has no file extension. This covers client routes and email links such as `/verify-email`.
- Unknown paths under `/api/`, `/health/` and `/metrics` keep the JSON error. Other methods outside the API also get the JSON 404.
- A missing file with an extension and any path segment starting with `.` get a plain-text 404. Directories are never listed; a directory path without an extension gets `index.html` like any page.
- The directory is opened with `os.Root`, so `..` and symbolic links cannot reach files outside it.
- Caching: `.html` files use `no-cache`; `/assets/*` uses `public, max-age=31536000, immutable`; `/fixtures/v1/*` uses `public, max-age=3600`; other files use `no-cache`.
- Every static response sends `X-Content-Type-Options: nosniff`. HTML responses also send `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.

## Not present

No background goroutines for business work, no outbox or queue, and no HTTP-to-HTTPS redirect listener. HTTPS, HSTS and static serving are described in [OPERATIONS.md](OPERATIONS.md#configuration-rules) and above.
