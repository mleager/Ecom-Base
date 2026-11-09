# Key decisions

The choices that shape the whole project, with the reason for each. Topic documents hold the details. The full per-task decision logs are in the original `docs/*/IMPLEMENTATION_DECISIONS.md` files.

## Infrastructure and tooling

| Decision | Reason |
|---|---|
| One Go API, one PostgreSQL database. No queue, Redis, worker, scheduler, reverse proxy or payment provider. | The exercise is about application invariants and SQL transactions. Extra infrastructure would hide them. |
| Local Go, goose and sqlc binaries; Docker runs PostgreSQL only. | Fast native feedback; no tooling images to maintain. |
| `GOTOOLCHAIN=local`; `go.mod` says `go 1.26.0` since M15 task 2 (see [Observability](#observability-milestone-15)). | Prevents silent toolchain downloads. Newer installed Go (1.27.3) builds it unchanged. |
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
| `go.mod` moved from `go 1.25.1` to `go 1.26.0` in task 2, when these modules were added. `golang.org/x/crypto` moved to v0.58.0 at the same time. | OpenTelemetry v1.47.0 requires Go 1.26. Go 1.25 left upstream support when 1.27 shipped. Every `x/crypto` release that fixes the four findings `govulncheck` reports (none reachable; only `argon2` is used) also requires Go 1.26. |
| `golang.org/x/text` moved to v0.41.0 in task 1 (supports Go 1.25); the OpenTelemetry modules raised it to v0.43.0 in task 2. | `govulncheck` found GO-2026-6629 reachable through pgx's password preparation (SASLprep). |
| `golang.org/x/net` stays at v0.60.0 (indirect, through the OTLP exporter's gRPC dependency) after task 2. `govulncheck` reports GO-2026-6866 and GO-2026-6860 in its `html` package, which nothing here calls, and GO-2026-5932 (`x/crypto/openpgp`, unused). | The `x/net` fix, v0.62.0, was 12 days old on 2026-11-08, under the two-week rule for new versions. Raise it in a later task; `check` still fails on any reachable finding. |
| Traces export over **OTLP/HTTP** (protobuf, port 4318), not gRPC. | Same data model; no gRPC client to configure; works through ordinary HTTP proxies; the Collector's default HTTP port. |
| Only the standard `OTEL_*` variables configure telemetry: endpoint, headers, timeout, sampler, batch limits, service name and resource attributes, all read by the SDK. Traces are exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. The service name defaults to `ecom-api`; the sampler keeps the SDK default (parent-based, always on). | No project-specific settings to learn; any Collector, ADOT or vendor endpoint works unchanged. |
| Settings this build cannot honor fail startup instead of being ignored: `OTEL_TRACES_EXPORTER` other than `otlp` or `none`, and `OTEL_EXPORTER_OTLP_PROTOCOL` or `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` other than `http/protobuf`. `OTEL_SDK_DISABLED=true` turns off traces and the metrics listener. | A silently ignored setting looks like a broken Collector. Same fail-at-startup rule as the rest of the configuration. |
| With nothing set, startup creates no-op providers, logs nothing extra and opens no connection or listener. When something is on, one `telemetry configured` line records it. Export failures are logged at `WARN` at most once a minute, with a count of the suppressed ones. Spans are queued in the SDK's batch processor, which drops rather than blocks when full; shutdown flushes within the same 10 s deadline as the HTTP shutdown. | Log output is unchanged for anyone not using telemetry. An unreachable Collector cannot slow requests, hold up shutdown or flood the logs. |
| Propagation: W3C `traceparent`/`tracestate` only. An incoming trace context is honored. No baggage. | A proxy, CDN or the Project 7 workers can continue a trace. Baggage could carry personal data across boundaries. |
| **Metrics are pulled**, in Prometheus format, from `METRICS_ADDR`, through the OpenTelemetry metrics API and its Prometheus exporter. Go runtime and process metrics come from `client_golang`'s collectors on the same registry. No OTLP metrics push. | Prometheus scraping is what Project 2's rollout analysis and Project 4 use. One delivery path keeps the contract simple; a Collector can scrape the endpoint with its Prometheus receiver when OTLP is wanted. |
| `METRICS_ADDR`: unset means no listener. When set, it is a `host:port`; local mode requires a loopback host, as for `HTTP_ADDR`; production allows any host; its port must differ from `HTTP_ADDR`'s (which also rules out overlapping binds such as `0.0.0.0` and `127.0.0.1` on one port). Plain HTTP, `GET /metrics` only, no authentication. The admin-only `/metrics` route on the API is unchanged. | Prometheus cannot hold short-lived admin tokens. Keeping it off the public listener means a CDN or load balancer never routes to it; exposure is a deployment decision, documented in OPERATIONS. |
| **HTTP instrumentation is our own** `httpserver` middleware, not `otelhttp`. | Span and metric names must use the chi route pattern, which is known only after routing. `otelhttp` records the request path (`url.path`), which the data rules forbid. It would also add the `httpsnoop` dependency. |
| **The pgx tracer is our own** `pgx.QueryTracer` (plus batch tracing), not `otelpgx`. Pool statistics come from `pgxpool.Stat` as observable gauges. | About a hundred lines. The rule "statement text, never arguments" is enforced and tested in our code rather than by a library option. No extra dependency. |
| **Pool size:** `database.Open` keeps its defaults (at most 10 connections, minimum 0) only when `DATABASE_URL` does not set pgx's standard `pool_max_conns` or `pool_min_conns`. | Scenarios tune the pool through configuration. No new variable, and the existing URL rules already allow these parameters. |
| Logs: a `slog` handler wrapper adds `trace_id` and `span_id` from the context when a valid span is active. Request logging passes the request context. | Lets a log store link to traces. Nothing changes when tracing is off. |
| HTTP names and labels (task 3) follow the OpenTelemetry HTTP semantic conventions: span `{method} {route}`; metrics `http.server.request.duration` (seconds, convention buckets) and `http.server.active_requests`. The duration labels are only `http.request.method`, `http.route` and `http.response.status_class` (`2xx`…`5xx`), not the exact status code. Methods outside the standard nine become `_OTHER`. | Status class is what the data rules allow and what error-ratio alerts need; it keeps series per route to a handful. Clients can send any method token, so it must be bounded too. |
| Database names (task 4) follow the semantic conventions: client span and `db.client.operation.duration` named by `db.operation.name`, which is the sqlc query name (`GetProduct`) or, for hand-written SQL, the leading keyword from a fixed list (`BEGIN`, `COMMIT`, `SELECT`…; anything else is `OTHER`). Spans carry `db.query.text` without sqlc's name comment and never the arguments. Errors record only the SQLSTATE code (or `canceled`, `timeout`, `other`), never the message, because PostgreSQL details quote row values. | The query name is a bounded, readable label that maps straight to `backend/queries/*.sql`. API SQL is fixed and parameterized, so the text holds placeholders only. |
| Query spans start only under an existing span. Query metrics are recorded for every query. | Readiness probes are not traced, so their queries would otherwise create a root span every few seconds. |
| Pool metrics: `db.client.connection.count` (`used`, `idle`), `.max`, `.idle.min` and `.timeouts` from `pgxpool.Stat` at collection; `db.client.connection.wait_time` and `.pending_requests` from pgxpool's acquire hook. Every series carries `db.client.connection.pool.name=main`. | Covers saturation (used versus max, waiters, acquire time) for Project 4's connection-exhaustion experiment. `pgxpool.Stat` has no current-waiters figure, so the acquire hook counts them. |
| `pool_min_conns` above the maximum (including the default 10) fails startup. Other pgx `pool_*` parameters (for example `pool_max_conn_lifetime`) were already honored and still are. | A silent clamp would hide a misconfigured scenario. |
| Business counters (task 5) live in `platform/metrics`, which depends only on the OpenTelemetry metrics API and is passed in explicitly (`auth.HTTPOptions.Metrics`, `checkout.Service.UseMetrics`, `email.Instrument`). A nil recorder counts nothing, so the CLIs and existing tests are unchanged. Every fixed series starts at zero. | No global meter state to reset between tests. Zero-valued series let `rate()` and absence-free alerts work before the first event. |
| Counters: `ecom.orders.created` (`customer.type` account/guest) counts acknowledged new orders; `ecom.payment.results` (`payment.result` accepted/rejected) counts settlements during checkout; `ecom.checkout.unknown_outcomes` (`customer.type`, `outcome.reason` uncertain = 503, interrupted = 202) counts responses that leave the outcome open; `ecom.guest.sessions.created`; `ecom.rate_limit.rejections` (`limiter.name`, `limiter.reason` throttled/capacity); `ecom.email.deliveries` (`email.result` sent/failed). Replays count nothing. | These are the commerce signals Projects 2 and 4 alert on. A delivery counter with a result label gives the failure ratio, not just failures. An order whose commit acknowledgement was lost and is later found is returned as a replay and not counted; that path is rare and already returns 200. |
| Rate limits counted are the 16 named in-process key limiters (`auth_ip`, `auth_email`, `security_ip`, `security_user`, `security_token`, `password_reset_address`, `guest_bootstrap`, `guest_read`, `guest_write`, `guest_owner`, `guest_rotation`, `guest_recovery_request`, `guest_recovery_confirmation`, `guest_checkout_prepare`, `guest_checkout_mail`, `guest_checkout_proof`). Not counted: the password-hashing concurrency limit (`auth_capacity`), the database-backed security-mail limit, and the guest write-slot limit. | The key limiters are the abuse signal. The others are concurrency or per-account policies that return different codes; they can be added later without changing these names. |
| Mail: `email.Instrument` wraps an enabled sender with a client span `smtp send` (`server.address`, `server.port`, `email.message.count`; `error.type=delivery_unconfirmed`) and the delivery counter. Disabled mail is not wrapped. Never addresses, subjects or bodies. | The transport deliberately reports every failure as one error, so the span cannot say more without leaking server responses. With mail off, every send "fails" by design and would be noise. |
| Requests without a route pattern share fixed `http.route` values: `static` for every SPA fallback response (pages, assets, missing assets), `unmatched` for unknown paths and methods (404 and 405, including chi's mount-level `/*` patterns). | One value each keeps unknown and client-routed paths from adding series. The convention would omit `http.route`, but an explicit value is easier to query and document. |
| A request whose client went away is recorded as 499 (class `4xx`), matching the log, and is not a span error. Only 5xx and panics set the span's error status (`error.type` is the status code or `panic`; never the panic value). | Disconnects are not server faults and must not trip a 5xx alert. |
| Export check image: `otel/opentelemetry-collector:0.164.0@sha256:28b6d41ac51bff6b41ba5e8fe503569ffb9d6a1ea90f7a78419e86f34e44f750` (multi-arch index; released 2026-10-26). Its core distribution has the OTLP receiver, the Prometheus receiver and the `debug` exporter. 0.165.0 was skipped because it was one day old. | Proves real OTLP export and that `METRICS_ADDR` parses as Prometheus, without building Project 4's stack. Pinned by digest. |
| The contract (task 6) is `backend/OBSERVABILITY_CONTRACT.md`, contract version 1. Its metrics table is tested: `TestContractListsEveryMetric` builds the HTTP, database and business instruments through the constructors `main.go` uses, records each one with an SDK view as it is created, and asks the real Prometheus exporter what it names each one. The test fails on a missing row, a stale row or a wrong Prometheus name. Spans and log fields are listed but not tested against the doc; their names are fixed in code and covered by the instrumentation tests. | Drift is caught in `check` without a database or a scrape. Asking the exporter keeps the Prometheus names exact (unit suffixes, `_total`) without copying its naming rules. |
| The export check drives a browser journey against `serve-https`, in a scripted headless Chromium (guest checkout, accepted and rejected), not through the HTTPS browser group. Metrics reach the Collector through its Prometheus receiver scraping `METRICS_ADDR`, as decided above; spans arrive over OTLP. | The browser harness starts a fresh API per test and deliberately drops `METRICS_ADDR` and `OTEL_*` from its environment, so its APIs never export. The HTTPS group still runs unchanged as a regression gate. |

## Packaging (Milestone 16)

Decided 2026-11-09 by M16 task 1. Design: [MILESTONE_16.md](MILESTONE_16.md).

| Decision | Reason |
|---|---|
| **Migrations ship in the application image and run as a separate one-off job before the API starts.** The SQL files are compiled into a new `cmd/migrate` binary with `//go:embed` and applied through goose used as a Go library. The image holds both `api` and `migrate`; the deployment runs `migrate` to completion, then starts `api`. The API never migrates at startup. | One image digest identifies both code and schema, which Project 2's rollouts and the migration fault-variant images depend on. A separate migrator image would need building, tagging and keeping in step with every app image. The same image and command run as a Compose one-shot service, an ECS task or a Kubernetes Job. |
| Only the `migrate` job receives the `ecom_migrator` credentials; the API keeps `ecom_app`. | Keeps the existing role split: the API cannot change the schema. Migrating at API startup would break it. |
| `migrate` applies migrations forward only (`up`, plus a read-only `status`) and holds a PostgreSQL advisory lock while it runs, so two jobs cannot migrate at once. goose's down migrations stay a development tool; a bad production migration is fixed by a new forward migration. | Rolling back schema in production can destroy data. Forward fixes are the recovery path the "failed migration" scenario documents. |
| goose becomes a Go module dependency of `cmd/migrate`, pinned under the two-week rule and checked by `govulncheck`. This replaces "goose is an installed CLI" for the release path; the fixture tool, `dev.sh migrate` and the integration tests may keep the CLI until task 2 decides whether to move them to the embedded files. | goose documents embedding as the production approach for Go applications. Copying the CLI into the image instead would add a second, larger binary built with drivers for many databases, and SQL files that could change without a rebuild. |
| **Readiness accepts a minimum schema version.** `/health/ready` passes when the applied goose version is **at least** the build's minimum (13 today) instead of exactly 13. Migrations that remove or rename something (the "contract" step) run only after every replica of the older release is gone. | An exact match makes every running replica of the old release fail readiness as soon as an expand migration is applied, which blocks expand-and-contract releases and the scenario that demonstrates them. |
| **Runtime base image:** `gcr.io/distroless/static-debian12:nonroot`, pinned by digest (chosen in task 2 under the two-week rule). Both Go binaries are built with `CGO_ENABLED=0`; the built SPA is copied beside them. | No shell or package manager to exploit, a non-root user by default and a small image. pgx and Argon2id are pure Go, so static binaries work. |
| The image has no shell, `curl` or `wget`, so it gets no in-container health check. Compose orders `postgres` (health-checked with `pg_isready` in its own image) and `migrate` (`service_completed_successfully`) before `api`; nothing waits on the API. Verification probes `/health/ready` from the host, and ECS, Kubernetes and load balancers probe from outside the container. Debugging uses `docker debug` or an ephemeral container instead of a shell. | Avoids adding a probe binary or subcommand only for Compose. Alpine was the alternative, at the cost of a larger attack surface. |
| **Secrets in Compose:** each service reads its own ignored env file (for example `.env.deploy` and `.env.migrate`, mode 0600): `migrate` gets the `ecom_migrator` URL, `api` gets the `ecom_app` URL and `JWT_SECRET_BASE64`. Not Compose `secrets`. Nothing secret is built into the image. | The application already reads its settings from environment variables, which is also how ECS (from Secrets Manager) and Kubernetes (`secretKeyRef`) inject secrets, so no code change. Compose `secrets` arrive as files and would need `*_FILE` support or a shell entrypoint, which distroless cannot run. Known limit: values are visible to anyone who can run `docker inspect` on the host. |
| **Certificates in Compose:** reuse the M14 local CA from `scripts/certs.sh`. `server.pem` and `server.key` are mounted read-only into `api`, `postgres.pem` and `postgres.key` into `postgres`, and `ca.pem` into `migrate` and `api`. The database service is named `postgres`, which `postgres.pem` already names, so `migrate` and `api` connect with `sslmode=verify-full`. Real deployments supply their own certificates; in M17 public HTTPS ends at CloudFront and the load balancer. | Verification uses the same trust chain as the M14 smoke tests, and no certificate or key enters the image. |

## Scope

| Decision | Reason |
|---|---|
| Keep both `accept` and `reject` payment scenarios, chosen explicitly by the shopper. | Shows both settlement and stock release. |
| Rejection does not refill the cart. | T1 consumed the cart; rebuilding it is a deliberate shopper action. |
| Guest checkout keeps shipping and contact on the server; the browser keeps only a reference. | No personal data in localStorage. |
| Sign-in never merges carts. The shopper picks **Keep account cart** or **Use guest cart**. | No silent data changes. |
| Search is literal, case-insensitive substring matching on name or SKU. No ranking, facets or search service. | Enough for the portfolio catalog. |
| No count endpoints; pagination is Previous/Next only. | Avoids extra queries and invented totals. |
