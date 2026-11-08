# Key decisions

The choices that shape the whole project, with the reason for each. Topic documents hold the details. The full per-task decision logs are in the original `docs/*/IMPLEMENTATION_DECISIONS.md` files.

## Infrastructure and tooling

| Decision | Reason |
|---|---|
| One Go API, one PostgreSQL database. No queue, Redis, worker, scheduler, reverse proxy or payment provider. | The exercise is about application invariants and SQL transactions. Extra infrastructure would hide them. |
| Local Go, goose and sqlc binaries; Docker runs PostgreSQL only. | Fast native feedback; no tooling images to maintain. |
| `GOTOOLCHAIN=local`; `go.mod` says `go 1.25.1` until M15 task 2 raises it to `go 1.26.0` (see [Observability](#observability-milestone-15)). | Prevents silent toolchain downloads. Newer installed Go (1.27.3) builds it unchanged. |
| Exact npm pins (`save-exact`, `engine-strict`), `npm ci` only. | Reproducible frontend installs. |
| `postgres:16-alpine` is a moving tag; record its digest in release evidence. | It is not an immutable pin. |
| No lint/format framework beyond `gofmt`, `go vet` and `.editorconfig`. | Avoids dependencies without a demonstrated need. |
| `govulncheck` v1.9.0 runs in `check`; a reachable known vulnerability fails it. It queries vuln.go.dev, so `check` needs network access. | Catches vulnerable dependencies and standard-library versions before release, at no runtime cost. |

## Data and transactions

| Decision | Reason |
|---|---|
| Money is `BIGINT` cents, USD only, capped at 1,000,000,000,000 per value. | No floating point; stays below JavaScript's exact-integer limit. |
| T1 (reserve) and T2 (settle) are separate transactions, with a committed processing claim in between and simulation outside any transaction. | No locks held during payment work; every crash point is recoverable. |
| Idempotency fingerprint is a canonical SHA-256 of the original intent, and lookup happens before reading the mutable cart. | A retry stays valid after checkout empties the cart. |
| A lost COMMIT reply is resolved by a fresh-connection lookup under the same key lock; if still unknown, return 503. | Absence of evidence is not proof of rollback. |
| Recovery is an explicit operator CLI (dry-run by default). | No hidden background worker; every action is auditable. |
| Retire products and deactivate users instead of deleting them. | Order history stays intact. |
| Runtime and migrator database roles are separate, with column-scoped grants. | Limits the damage of an application bug. |

## Security

| Decision | Reason |
|---|---|
| Argon2id (64 MiB, 3 iterations, parallelism 1), at most 2 concurrent hashes per process. | Memory-hard hashing with bounded resource use. |
| Passwords are 15–128 code points, at most 512 bytes, never trimmed or normalized. | Supports passphrases; no surprising transformations. |
| 15-minute HS256 JWT in memory plus a 7-day fixed refresh cookie, rotated on use. | Short exposure window; no token in browser storage. |
| Database session check on every request. | Logout, deactivation and role changes take effect immediately. |
| Exact Origin plus `X-CSRF-Protection: 1` on every cookie-based write. | CSRF defence in addition to SameSite=Strict. |
| Rate limits are in-process and keyed on `RemoteAddr`; forwarding headers are ignored. | Correct for a single direct deployment. A proxy would need a deliberate change. |
| Email links carry tokens in the URL fragment; the app removes the fragment before routing and keeps the token in memory. | Tokens never reach server logs, Referer headers or browser storage. |
| SMTP via the Go standard library, STARTTLS or TLS only, sent once after commit. | No new dependency and no plaintext fallback. Mail failure never undoes a committed change. |

## Frontend

| Decision | Reason |
|---|---|
| Native `fetch`, React context and hooks; no state, HTTP or form library. | The requirements do not need one. |
| One typed API boundary with runtime response guards and OpenAPI contract tests; no code generator. | One place for error, retry and credential rules. |
| Writes are **send-once**. Only reads (and name-only profile PATCH) may replay once after a definitive 401. | A replayed mutation could duplicate a committed change. |
| Web Locks and BroadcastChannel are required. If unavailable, the app fails closed. | Safe cross-tab coordination without storing tokens. |
| Checkout recovery stores the original key and body in localStorage before sending. | Lets the shopper resume the exact original request after a crash or reload. |
| Tailwind (`tw:` prefix, no Preflight) coexists with CSS Modules; shadcn components are copied into the repo. | Incremental migration without breaking existing styles. |

## Production serving and HTTPS (Milestone 14)

Selected 2026-11-07 and implemented by M14 tasks 2–9. The design and configuration contract are in [MILESTONE_14.md](MILESTONE_14.md).

| Decision | Reason |
|---|---|
| The Go API terminates TLS itself (`ListenAndServeTLS`, minimum TLS 1.2). No reverse proxy. | Keeps the single-process architecture. `RemoteAddr` remains the real client, so rate limits stay correct without trusted-proxy rules. |
| The API serves the built SPA and the API from **one origin** when `STATIC_DIR` is set. | One cookie site; no CORS in production; email links built from `FRONTEND_ORIGIN` land on the same server. |
| SPA fallback to `index.html` only for `GET`/`HEAD` requests without a file extension, outside `/api/`, `/health/` and `/metrics`. | Direct navigation and email links work, while API and asset 404s stay real 404s. |
| `index.html` is `no-cache`; hashed `/assets/*` are `immutable` for one year; HTML responses add `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. | New deployments take effect immediately; token-bearing pages never leak a Referer. |
| The frontend also accepts a relative `VITE_API_BASE_URL=/api/v1`, resolved against the page origin. The absolute form stays for the Vite dev server. | One build works on any HTTPS host. Storage and lock keys use the resolved URL, so they stay stable per origin. |
| Secure cookies when `APP_ENV=production` **or** TLS is on. | A cookie sent over HTTPS should never be usable over plain HTTP, even in local mode. |
| HSTS only in production **with** TLS. | HSTS on `localhost` would force HTTPS on every localhost port, breaking the Vite dev server. |
| `TLS_CERT_FILE` and `TLS_KEY_FILE` must both be set or both empty; production requires them. Empty values mean unset. | Fails fast on half-configured TLS instead of silently serving HTTP. |
| Local certificates come from `scripts/certs.sh` (OpenSSL): a local CA plus server certificates in the ignored `.cache/certs/`. `mkcert` is optional. | No new required tool; OpenSSL is already needed by `init-env`. Private keys never enter the repository. |
| Database TLS uses an opt-in `compose.tls.yaml` (`ssl=on`) and `sslmode=verify-full&sslrootcert=…`. The default dev database stays without TLS. | Satisfies the existing production rule without slowing daily work. |
| The plain-HTTP development flow and its browser suite stay the default. HTTPS is an added run mode with its own browser group, which skips certificate checks only inside that Playwright project. | Avoids churn in 348 working tests; the certificate chain is verified by Go tests instead. |
| No HTTP-to-HTTPS redirect listener, ACME or CSP hardening in M14. | Out of scope for the local lab; can be added later if a deployment needs it. |

## Observability (Milestone 15)

Confirmed 2026-11-08 by M15 task 1. The design and data rules are in [MILESTONE_15.md](MILESTONE_15.md). The observability stack itself belongs to Project 4 ([PORTFOLIO_MASTER_CONTEXT.md](PORTFOLIO_MASTER_CONTEXT.md#56-key-engineering-requirements)).

| Decision | Reason |
|---|---|
| **New dependencies:** OpenTelemetry Go v1.47.0 (`otel`, `sdk`, `sdk/metric`), the OTLP/HTTP trace exporter v1.47.0, and the OpenTelemetry Prometheus exporter v0.69.0 with `prometheus/client_golang` v1.25.0. Measured cost: the API binary grows from about 4.2 MB to about 13 MB, and linked non-standard packages from 48 to about 250. gRPC and grpc-gateway get linked through the official OTLP proto package even with the HTTP exporter. | The need is demonstrated: every scenario project diagnoses incidents from this telemetry and cannot add it later. A hand-written OTLP or Prometheus exporter would be a bespoke protocol implementation to maintain. Versions are pinned and `govulncheck` checks them. |
| `go.mod` moves from `go 1.25.1` to `go 1.26.0` in task 2, when these modules are added. `golang.org/x/crypto` moves to v0.58.0 at the same time. | OpenTelemetry v1.47.0 requires Go 1.26. Go 1.25 left upstream support when 1.27 shipped. Every `x/crypto` release that fixes the four findings `govulncheck` reports (none reachable; only `argon2` is used) also requires Go 1.26. |
| `golang.org/x/text` moved to v0.41.0 now (supports Go 1.25). | `govulncheck` found GO-2026-6629 reachable through pgx's password preparation (SASLprep). |
| Traces export over **OTLP/HTTP** (protobuf, port 4318), not gRPC. | Same data model; no gRPC client to configure; works through ordinary HTTP proxies; the Collector's default HTTP port. |
| Only the standard `OTEL_*` variables configure telemetry: endpoint, headers, timeout, sampler, batch limits, service name and resource attributes, all read by the SDK. Traces are exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. The service name defaults to `ecom-api`; the sampler keeps the SDK default (parent-based, always on). | No project-specific settings to learn; any Collector, ADOT or vendor endpoint works unchanged. |
| Propagation: W3C `traceparent`/`tracestate` only. An incoming trace context is honored. No baggage. | A proxy, CDN or the Project 7 workers can continue a trace. Baggage could carry personal data across boundaries. |
| **Metrics are pulled**, in Prometheus format, from `METRICS_ADDR`, through the OpenTelemetry metrics API and its Prometheus exporter. Go runtime and process metrics come from `client_golang`'s collectors on the same registry. No OTLP metrics push. | Prometheus scraping is what Project 2's rollout analysis and Project 4 use. One delivery path keeps the contract simple; a Collector can scrape the endpoint with its Prometheus receiver when OTLP is wanted. |
| `METRICS_ADDR`: unset means no listener. When set, it is a `host:port`; local mode requires a loopback host, as for `HTTP_ADDR`; production allows any host; it must not equal `HTTP_ADDR`. Plain HTTP, `GET /metrics` only, no authentication. The admin-only `/metrics` route on the API is unchanged. | Prometheus cannot hold short-lived admin tokens. Keeping it off the public listener means a CDN or load balancer never routes to it; exposure is a deployment decision, documented in OPERATIONS. |
| **HTTP instrumentation is our own** `httpserver` middleware, not `otelhttp`. | Span and metric names must use the chi route pattern, which is known only after routing. `otelhttp` records the request path (`url.path`), which the data rules forbid. It would also add the `httpsnoop` dependency. |
| **The pgx tracer is our own** `pgx.QueryTracer` (plus batch tracing), not `otelpgx`. Pool statistics come from `pgxpool.Stat` as observable gauges. | About a hundred lines. The rule "statement text, never arguments" is enforced and tested in our code rather than by a library option. No extra dependency. |
| **Pool size:** `database.Open` keeps its defaults (at most 10 connections, minimum 0) only when `DATABASE_URL` does not set pgx's standard `pool_max_conns` or `pool_min_conns`. | Scenarios tune the pool through configuration. No new variable, and the existing URL rules already allow these parameters. |
| Logs: a `slog` handler wrapper adds `trace_id` and `span_id` from the context when a valid span is active. Request logging passes the request context. | Lets a log store link to traces. Nothing changes when tracing is off. |
| Export check image: `otel/opentelemetry-collector:0.164.0@sha256:28b6d41ac51bff6b41ba5e8fe503569ffb9d6a1ea90f7a78419e86f34e44f750` (multi-arch index; released 2026-10-26). Its core distribution has the OTLP receiver, the Prometheus receiver and the `debug` exporter. 0.165.0 was skipped because it was one day old. | Proves real OTLP export and that `METRICS_ADDR` parses as Prometheus, without building Project 4's stack. Pinned by digest. |

## Scope

| Decision | Reason |
|---|---|
| Keep both `accept` and `reject` payment scenarios, chosen explicitly by the shopper. | Shows both settlement and stock release. |
| Rejection does not refill the cart. | T1 consumed the cart; rebuilding it is a deliberate shopper action. |
| Guest checkout keeps shipping and contact on the server; the browser keeps only a reference. | No personal data in localStorage. |
| Sign-in never merges carts. The shopper picks **Keep account cart** or **Use guest cart**. | No silent data changes. |
| Search is literal, case-insensitive substring matching on name or SKU. No ranking, facets or search service. | Enough for the portfolio catalog. |
| No count endpoints; pagination is Previous/Next only. | Avoids extra queries and invented totals. |
