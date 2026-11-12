# Implementation sequence

**Updated:** 2026-11-07.  
**Progress:** Milestones 1–16 are complete (M16, final baseline release, tagged `v1.0.0` locally on 2026-11-09). Next is Milestone 17 (CDN frontend and load-balanced API).

## How to use this file

1. Work on **one task at a time**, in order, unless a task says it can run in parallel.
2. Before starting, read the milestone document ([M14](MILESTONE_14.md), [M15](MILESTONE_15.md), [M16](MILESTONE_16.md), [M17](MILESTONE_17.md)) and the topic documents the task names.
3. A task is done only when its **Done when** items and its **Verify** gate pass. Record what actually ran.
4. After each verified task, tick its box here and update [STATUS.md](STATUS.md). Update the topic documents in the same change as the code.
5. If a task uncovers a design problem, stop and record the decision in [DECISIONS.md](DECISIONS.md) before continuing.

Verification levels follow [frontend/TESTING.md](frontend/TESTING.md#when-to-run-what): changes to shared API configuration, cookies, routing or the harness require the **full** browser suite.

## Milestones 1–13 (complete)

| # | Milestone | Detail |
|---|---|---|
| 1–5 | Backend: core database, transactional orders, simulated payment, recovery, readiness | [backend sequence](../backend/IMPLEMENTATION_SEQUENCE.md) |
| 6–13 | Frontend: design, auth, catalog, account and cart, checkout, admin, visual design, shopping revision and guest checkout | [frontend sequence](../frontend/IMPLEMENTATION_SEQUENCE.md) |

## Milestone 14 — Production serving and HTTPS

Status: **complete** — all 10 tasks done and accepted (2026-11-07). Design: [MILESTONE_14.md](MILESTONE_14.md).

1. [x] **Record the serving and TLS decisions**
   - Add the M14 choices to [DECISIONS.md](DECISIONS.md): Go-native TLS, same origin, SPA fallback rules, relative API base, the Secure cookie rule, HSTS only in production, local CA tooling and database TLS.
   - Add the new settings (`TLS_CERT_FILE`, `TLS_KEY_FILE`, `STATIC_DIR`) to `.env.example` as commented, empty entries.
   - **Done when:** the decisions and config contract match MILESTONE_14.md, and no code has changed yet.
   - **Verify:** documentation links pass.
   - **Result (2026-11-07):** decisions added to [DECISIONS.md](DECISIONS.md#production-serving-and-https-milestone-14); `.env.example` gains commented `TLS_CERT_FILE`, `TLS_KEY_FILE` and `STATIC_DIR`. Both env loaders skip comments, so `init-env` and existing `.env` files are unaffected. Links pass. No code changed.

2. [x] **Local certificate tooling**
   - Add `scripts/certs.sh`. It uses OpenSSL to create a local CA and a server certificate in `.cache/certs/` (git-ignored).
   - Subject names: `localhost`, `127.0.0.1` and `::1` for the API, and `localhost` plus `postgres` for the database.
   - The script refuses to overwrite existing files, sets key files to mode 0600, and prints only file paths.
   - Document how to trust the CA in a desktop browser, with `mkcert` noted as an optional alternative.
   - **Done when:** running the script twice is safe, and `openssl verify -CAfile ca.pem server.pem` passes.
   - **Verify:** run the script; `bash -n scripts/certs.sh`.
   - **Result (2026-11-07):** `scripts/certs.sh` creates an EC P-256 CA (10 years, `pathlen:0`) plus `server` and `postgres` certificates (397 days, `serverAuth`, the listed SANs). Files are assembled in a temporary directory and moved into place without overwriting; directory 0700, keys 0600. Checked in a scratch copy: a second run only verifies; an incomplete set, a mismatched key and unexpected arguments all fail without changes; `openssl verify` passes for both leaves; an `openssl s_server` handshake verifies for `localhost` and fails with a hostname mismatch for another name. The real set now exists in the ignored `.cache/certs/`. Browser trust steps are in [DEVELOPMENT.md](DEVELOPMENT.md#local-https-certificates). No application code changed.

3. [x] **TLS listener and configuration**
   - In `config.go`, parse `TLS_CERT_FILE` and `TLS_KEY_FILE`. Both or neither may be set, the files must be readable, and production requires them.
   - In `cmd/api/main.go`, use `ListenAndServeTLS` when TLS is configured, with `MinVersion: tls.VersionTLS12`.
   - Secure cookies turn on when the environment is production **or** TLS is on. This applies to `ecom_refresh`, `ecom_guest` and `ecom_guest_recovery`.
   - Add HSTS (`max-age=31536000`) only when production and TLS are both on.
   - **Done when:** half-configured TLS fails at startup with a clear error, an HTTPS request succeeds with the test certificate, and cookie attributes match the rule in every mode.
   - **Verify:** config unit tests for every combination, server tests with a generated certificate, cookie assertions, and `bash scripts/dev.sh check` plus `integration --race`.
   - **Result (2026-11-07):** `config.Load` reads `TLS_CERT_FILE` and `TLS_KEY_FILE`, rejects a half pair, and requires both in production. `Config.SecureCookies()` (production or TLS) and `Config.HSTS()` (production and TLS) drive all three cookies and the header from one place. `httpserver.EnableTLS` loads the pair before listening (TLS 1.2 minimum), and `main.go` uses `ListenAndServeTLS` and sends server messages to the JSON log. Tests:
     - config cases for every mode and pair combination
     - an HTTPS round trip with a generated certificate, rejecting a TLS 1.1 client and a client without the CA
     - missing, mismatched and swapped files
     - HSTS middleware
     - a new `ecom_guest_recovery` attribute test, alongside the existing `ecom_refresh` and `ecom_guest` tests

     `check` and `integration --race` pass. A manual run with the binary and `.cache/certs/` showed:
     - a half pair and a mismatched key each stop startup with a clear error
     - `https://localhost:8443` and `https://127.0.0.1:8443` verify against `ca.pem`, and a client without the CA is refused
     - logout clears `ecom_refresh` with `Secure` over HTTPS and without it over HTTP
     - no HSTS in local mode

     Production-mode HSTS is covered by tests only until task 9.

4. [x] **Static SPA serving with fallback**
   - Add an optional static handler, enabled only by `STATIC_DIR`. Startup fails if `index.html` is missing.
   - Request order: `/api/v1/*`, then `/health/*` and `/metrics`, then static files, then the `index.html` fallback. The fallback covers only `GET` and `HEAD` requests without a file extension.
   - Unknown `/api/*` paths keep the JSON 404. Missing asset files return a plain 404.
   - Block dotfiles, directory listings and path traversal.
   - Caching: `no-cache` for `index.html`; `max-age=31536000, immutable` for `/assets/*`; a short cache for `/fixtures/v1/*`.
   - HTML responses get `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
   - **Done when:** every frontend route and every email-link path (`/verify-email`, `/confirm-email-change`, `/reset-password`, `/guest/recover`) returns `index.html`, and API and operational routes behave exactly as before.
   - **Verify:** handler unit tests using `fstest.MapFS` (route matrix, traversal, HEAD, headers), plus `check` and `integration --race`.
   - **Result (2026-11-07):** `httpserver.Static` opens `STATIC_DIR` with `os.Root` and requires a regular `index.html`; `httpserver.SPA` replaces only the root fallback, so API subrouters keep the JSON 404. `main.go` checks the directory before connecting to the database. `config` gains `StaticDir`.
     - The route-matrix tests cover every route family and email-link path, files with their cache headers, dotfiles, traversal, HEAD, API and operational routes, and non-GET methods.
     - A real-directory test shows that sibling files and symbolic links pointing out of the root are not served.
     - Without `STATIC_DIR`, every unknown path still returns the JSON 404.
     - `check` and `integration --race` pass.
     - A manual HTTPS run with the real `frontend/dist` behaved as specified. Unknown `/api/v1/*` GETs return a JSON 405 rather than a 404, because of the existing `OPTIONS /*` preflight route. This is unchanged and also happens without `STATIC_DIR`.

5. [x] **Same-origin frontend API base**
   - In `resolveApiBaseUrl`, also accept the relative value `/api/v1` and resolve it against `window.location.origin`. Keep the HTTPS-or-loopback rule on the resolved URL.
   - The resolved absolute URL continues to name the storage and lock keys, so keys stay stable per origin.
   - Add a `build:same-origin` script (implemented as `vite build --mode same-origin`, which defines `VITE_API_BASE_URL=/api/v1` and works on any shell). The default dev behavior is unchanged.
   - **Done when:** the relative and absolute forms both pass validation tests, invalid forms are still rejected, and recovery-record keys are unchanged for the dev origin.
   - **Verify:** `npm test`, `npm run typecheck`, `npm run build`, and the **full** `npm run test:e2e` (shared API configuration changed).
   - **Result (2026-11-07):** `resolveApiBaseUrl` accepts exactly `/api/v1` (or `/api/v1/`) and resolves it against the page origin (an optional `origin` argument for tests). It fails when there is no usable origin, and then applies the same HTTPS-or-loopback, no-credentials, no-query rules. Protocol-relative and other relative forms are still rejected.
     - `build:same-origin` uses a Vite mode rather than an environment prefix. It is cross-platform and overrides `.env.local`. The built bundle calls `resolveApiBaseUrl("/api/v1")`, while the default build keeps the absolute default.
     - New unit tests cover the resolution, the rejection cases, and pinned recovery storage names (the dev-origin name is unchanged).
     - `npm run typecheck`, `npm test` (1,368), both builds and the **full** `npm run test:e2e` pass: 348/348 in about 18.5 minutes, pinned away from CPUs 8–9.
     - The first e2e attempt failed at browser launch because `PLAYWRIGHT_BROWSERS_PATH` pointed at the Windows-only `.cache/playwright`. This was environmental, and the docs now warn about it.

6. [x] **Database TLS**
   - Add a Compose override, `compose.tls.yaml`, that enables `ssl=on` with the task 2 certificate. The key is copied into the container with mode 0600, owned by the `postgres` user. The default `compose.yaml` is unchanged.
   - Add `bash scripts/dev.sh database-tls` (or a flag) to start the database with the override.
   - Add an opt-in integration test. It connects with `sslmode=verify-full&sslrootcert=.cache/certs/ca.pem`, and fails for a wrong host name and for an untrusted CA.
   - **Done when:** `verify-full` works against the local container, and the default development flow still uses `sslmode=disable`.
   - **Verify:** the opt-in TLS test, the normal `integration --race`, and `docker compose config --quiet` for both files.
   - **Result (2026-11-07):**
     - **Override:** `compose.tls.yaml` mounts only `postgres.pem` and `postgres.key`, read-only. Its entrypoint installs them as `postgres:postgres` (certificate 0644, key 0600) in `/var/lib/postgresql/tls`, then runs the image entrypoint with `ssl=on` and `ssl_min_protocol_version=TLSv1.2`. TLS is offered, not required, so `sslmode=disable` still works.
     - **`dev.sh` actions:** `database-tls` checks for the certificates first, because Docker would otherwise create missing mount sources as directories. `database-tls-check` runs `TestDatabaseTLS` (opt-in via `ECOM_DB_TLS=1`; skipped in normal runs).
     - **Test results against the TLS container:** `verify-full` passed for `localhost` and `127.0.0.1` (TLSv1.2/1.3 per `pg_stat_ssl`), the URL satisfies `config.ValidateDatabase("production", …)`, and the API pool connects over TLS. A wrong host name fails with an `x509.HostnameError`; another CA and system-roots-only both fail with `x509.UnknownAuthorityError`; `sslmode=disable` still connects without TLS.
     - **Against the plain container:** every TLS case fails clearly with "server refused TLS".
     - **API run:** the API with a `verify-full` `DATABASE_URL` reached readiness 200.
     - **Gates:** `integration --race` passed with the TLS container running, `check` passes, and `docker compose config --quiet` passes for both file sets.
     - **Restore:** the development container was switched back with `bash scripts/dev.sh database` (schema still at version 13).

7. [x] **Local HTTPS run mode**
   - Add `bash scripts/dev.sh serve-https`. It builds the frontend with the same-origin base, then runs the API in local mode on `https://localhost:8443` with TLS, `STATIC_DIR=frontend/dist` and `FRONTEND_ORIGIN=https://localhost:8443`.
   - Document the mode in [DEVELOPMENT.md](DEVELOPMENT.md).
   - **Done when:** in a browser that trusts the local CA you can sign in, reload, shop as a guest, check out with both scenarios, view orders and open an admin page, all on `https://localhost:8443`.
   - **Verify:** a manual smoke checklist recorded in STATUS.md.
   - **Result (2026-11-07):**
     - `dev.sh serve-https [fixture-id]` checks the certificates and `node_modules`, runs `build:same-origin`, then runs the API with the HTTPS settings overriding `.env`.
     - `dev.sh fixtures-https` creates a fixture whose image URLs and `api.env` use `https://localhost:8443`.
     - The smoke checklist in [STATUS.md](STATUS.md#local-https-smoke-m14-task-7-2026-11-07) passed in headless Chromium with `ignoreHTTPSErrors`. The certificate chain was verified separately with `curl --cacert`.
     - The script's first runs hit the API's in-memory rate limits (429) and two races in the smoke script itself; the server was restarted between runs.
     - **Still to do:** the same walk-through in a desktop browser that trusts `ca.pem`.

8. [x] **HTTPS browser test group**
   - Add a harness mode. It builds `dist` once per run, then for each test starts the API with TLS and `STATIC_DIR` on `https://localhost:18443` instead of using Vite. Fixtures stay per test.
   - Add a Playwright project or group, `test:e2e:https`, with `ignoreHTTPSErrors` for that project only. Update the group-coverage unit test.
   - Cases to cover:
     - deep-link navigation and reload for each route family
     - `Secure`, `HttpOnly` and `SameSite` attributes on all cookies (`context.cookies()`)
     - session restore after reload
     - guest cart, choice and checkout (accept and reject)
     - order detail and cancellation
     - an email-link page with a fragment
     - a JSON 404 for an unknown API path
     - cache headers on `index.html` and assets
   - **Done when:** the HTTPS group passes with one worker and zero retries, and the existing HTTP suite is unchanged.
   - **Verify:** `npm run test:e2e:https`, then the **full** `npm run test:e2e` (the harness changed).
   - **Result (2026-11-07):**
     - **Harness:** `backend.ts` gains a worker-scoped `transport` option. For `https` it:
       - builds the same-origin SPA once per run into `.cache/frontend-e2e-https/dist`
       - starts each fixture API on `https://localhost:18443` with the `.cache/certs` key pair and `STATIC_DIR`
       - probes readiness with the chain verified against `ca.pem`
       - exposes `backend.origin` for CSRF headers

       The mail-enabled API variant (`TestBrowserMailAPI`) honors `TLS_CERT_FILE`, `TLS_KEY_FILE` and `STATIC_DIR` too, so order cancellation runs over TLS. `playwright.https.config.ts` runs `tests/e2e-https/` with `ignoreHTTPSErrors` in its one project. Every test there starts its own API automatically.
     - **Ten cases**, all listed in [frontend/TESTING.md](frontend/TESTING.md#https-browser-group). Beyond the list above, they add a leftover plain-HTTP cookie that must not block the guest cart. `browserGroups.test.ts` checks the separate config and directory.
     - **Bug found and fixed:** every unknown `/api/v1` path answered **405** instead of a JSON 404, because the catch-all `OPTIONS /*` preflight route matched every path. Preflights are now answered by middleware before routing (`auth.answerPreflight`). Real routes with the wrong method stay 405. Unit cases were added in `TestCSRFAndCORS`.
     - **Runs:**
       - `npm run test:e2e:https`: 10/10 in about 58 s
       - `integration --race`, `check`, `npm run typecheck`, `npm test` (1,369) and `npm run build`: pass
     - **Full `npm run test:e2e`: 347/348.** The one failure, `guest-contract.spec.ts:34` (two tabs add to the cart at once, both badges expect 2), is intermittent and predates this task. It failed 1 of 5 isolated runs with this change, and 4 of 8 with the preflight change reverted. It was then diagnosed as a real lost add-to-cart click and fixed (see [STATUS.md](STATUS.md#local-https-smoke-m14-task-7-2026-11-07)).

9. [x] **Production-mode smoke**
   - Run the API with `APP_ENV=production`, TLS, `DATABASE_URL` using `verify-full` (task 6), `MAIL_MODE=smtp` (your configured SMTP) and `STATIC_DIR`. Use a non-loopback bind if needed.
   - Check the health routes, Secure cookies and HSTS. Request a verification email and open its link on the HTTPS origin.
   - **Done when:** production mode starts and serves the SPA, and a real email link opens and completes on HTTPS.
   - **Verify:** a manual run recorded in STATUS.md, without copying any secrets.
   - **Result (2026-11-07):** done; every check passed. Details: [STATUS.md](STATUS.md#production-mode-smoke-m14-task-9-2026-11-07).
     - The API ran with `APP_ENV=production` on `127.0.0.1:8443` (TLS, `STATIC_DIR`), `MAIL_MODE=smtp` with the private `.env` SMTP settings, and a `fixtures-https` database through `sslmode=verify-full` against PostgreSQL started with `database-tls`. `pg_stat_ssl` showed the API's connections on TLSv1.3.
     - A real verification email to `ECOM_MAIL_TEST_RECIPIENT` arrived, and its link opened on `https://localhost:8443` and completed verification. The link was opened in headless Chromium, not a desktop browser, because production mode sends HSTS for `localhost`.
     - The first send was reported as unconfirmed; the retry was accepted. See the SMTP limit in [STATUS.md](STATUS.md#known-limits).

10. [x] **Milestone acceptance**
    - Run `bash scripts/dev.sh check`, `integration --race`, `npm run typecheck`, `npm test`, `npm run build`, the full `npm run test:e2e` and `npm run test:e2e:https`.
    - Update [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md), [backend/OPERATIONS.md](backend/OPERATIONS.md), [frontend/ARCHITECTURE.md](frontend/ARCHITECTURE.md), [frontend/TESTING.md](frontend/TESTING.md) and [STATUS.md](STATUS.md).
    - **Done when:** all M14 gates in [MILESTONE_14.md](MILESTONE_14.md#release-gates-for-m14) pass, and their limits are recorded.
    - **Result (2026-11-07):** all six gates pass; every command exited 0 in one sequential run. Gate-by-gate evidence and the remaining limits: [STATUS.md](STATUS.md#m14-acceptance-task-10-2026-11-07). The docs update added a production-mode how-to and troubleshooting rows to [backend/OPERATIONS.md](backend/OPERATIONS.md#production-mode-on-one-host), and the HTTPS group to the run rules in [frontend/TESTING.md](frontend/TESTING.md#when-to-run-what). The two architecture docs were already current.

Acceptance: the application runs correctly from one HTTPS origin in both local and production modes, with database TLS verified, while the default development flow and all existing tests are unchanged.

## Milestone 15 — Observability

Status: **done** — accepted 2026-11-09. Design: [MILESTONE_15.md](MILESTONE_15.md). Scope: instrumentation built into the API; the observability stack belongs to Project 4.

1. [x] **Confirm the design.**
   - Confirm the SDK and exporters, the `METRICS_ADDR` listener and its bind rules, the source of the pgx tracer (written here or a library), the `pool_max_conns` approach, and the pinned Collector image for the export check.
   - Record them, and the dependency need, in DECISIONS.md.
   - Add `govulncheck` to `check`.
   - **Result (2026-11-08):** decisions recorded in [DECISIONS.md](DECISIONS.md#observability-milestone-15).
     - OpenTelemetry Go v1.47.0 with OTLP/HTTP traces. Metrics are pulled in Prometheus format from `METRICS_ADDR`.
     - The HTTP middleware and the pgx tracer are written here, not taken from `otelhttp` or `otelpgx`.
     - The pool size comes from pgx's `pool_max_conns`.
     - The export check uses `otel/opentelemetry-collector:0.164.0`, pinned by digest.
     - Measured cost: the binary grows from about 4.2 MB to about 13 MB.
     - OpenTelemetry v1.47.0 requires Go 1.26, so task 2 raises `go.mod` to `go 1.26.0` and `x/crypto` to v0.58.0.
     - `govulncheck` v1.9.0 now runs in `check`. Its first scan found GO-2026-6629 reachable in `golang.org/x/text`, which was raised to v0.41.0. `check` then passed with no reachable vulnerabilities. Four unreachable `x/crypto` findings remain until task 2.
     - `integration --race` passed after the `x/text` change (it is used by pgx for password-based sign-in).
2. [x] **Telemetry bootstrap.** Add a `platform/telemetry` package. It reads `OTEL_*` and `METRICS_ADDR`, sets up the trace and meter providers, exports nothing when unset, and flushes within the graceful shutdown.
   - **Done when:** startup with nothing set makes no outbound connections, and an unreachable endpoint never delays requests.
   - **Verify:** unit tests and `check`.
   - **Result (2026-11-08):**
     - `go.mod` is now `go 1.26.0`, with the OpenTelemetry modules from task 1 and `x/crypto` v0.58.0.
     - `config` reads and validates `METRICS_ADDR`: loopback only in local mode, and a port different from `HTTP_ADDR`'s (13 test cases).
     - `platform/telemetry` returns no-op providers and an empty propagator, and logs nothing, when nothing is set. Unsupported exporter or protocol values fail startup. `main.go` starts it before the database and flushes it inside the 10 s shutdown deadline.
     - Unit tests cover: off by default (no span recorded, an incoming `traceparent` ignored, no log line); the settings switches; real OTLP/HTTP export decoded with the OTLP protobuf types (`service.name` `ecom-api`, overridable); a Collector that never answers (2000 spans in well under a second, shutdown bounded by its deadline); the metrics listener (`GET /metrics` only, runtime, process and SDK metrics, closed after shutdown); a busy `METRICS_ADDR`; and once-a-minute export error logging.
     - `check` passed, and `govulncheck` reports no reachable vulnerabilities. Three unreachable findings remain in required modules (`x/net` `html`, `x/crypto/openpgp`); see [DECISIONS.md](DECISIONS.md#observability-milestone-15).
     - `integration --race` passed. The full browser suite (`npm run test:e2e`, 344 tests) passed with telemetry unset, since `main.go` startup changed.
3. [x] **HTTP instrumentation.** Add server spans and RED metrics in the `httpserver` middleware, named by chi route pattern. SPA and static paths get the `static` label; `/health/*` and `/metrics` are skipped. Request logs gain `trace_id` and `span_id`.
   - **Done when:** unknown paths add no series, and no raw URL or query string is recorded.
   - **Verify:** unit tests, and the full browser suite (shared middleware).
   - **Result (2026-11-08):**
     - `httpserver.NewInstrumented` takes the telemetry providers; `New` keeps its signature and records nothing. The middleware extracts W3C trace context, starts a server span, and after routing names it `{method} {route}` and records `http.server.request.duration` and `http.server.active_requests`. Label rules are in [DECISIONS.md](DECISIONS.md#observability-milestone-15).
     - `telemetry.LogHandler` wraps the JSON handler in `main.go`. The request log, the panic log and the checkout and security-mail handler logs now pass the request context, so they gain `trace_id` and `span_id` when a span is active.
     - Unit tests cover: the span name, kind, attributes and continued `traceparent`; no URL, query, ID or `Authorization` text in spans, metric labels or logs; 300 requests to unknown paths, SPA routes, missing assets, odd methods and 405s producing exactly five fixed series; no spans or metrics for `/health/*` and `/metrics`; 5xx and panic errors; client disconnects as 499; a log line identical to before when telemetry is off; and the Prometheus names on `METRICS_ADDR` (`http_server_request_duration_seconds`, `http_server_active_requests`).
     - `check` and `integration --race` passed. The full browser suite (`npm run test:e2e`, 344 tests) passed through the shared middleware.
4. [x] **Database instrumentation and pool size.** Add a pgx query tracer that records statement text without arguments, and `pgxpool` statistics as gauges. Honor `pool_max_conns` in `DATABASE_URL`, keeping 10 as the default.
   - **Done when:** query spans nest under request spans, a test proves arguments are never exported, and a test shows the pool size follows the URL.
   - **Verify:** `integration --race`.
   - **Result (2026-11-08):**
     - `database.OpenInstrumented` installs a pgx query and acquire tracer; `Open` keeps its signature and installs none. `main.go` passes the telemetry providers. Names and rules are in [DECISIONS.md](DECISIONS.md#observability-milestone-15).
     - `DATABASE_URL` may set `pool_max_conns` and `pool_min_conns`; 10 and 0 apply only when they are absent, and a minimum above the maximum fails startup. The readiness query gained a `-- name: ReadySchemaVersion` comment so it is labelled like sqlc's queries.
     - Unit tests cover pool sizes from the URL (including invalid values, with no password in errors), operation names, error codes without messages, nesting and argument absence with the in-memory exporter, no root spans for untraced queries, the acquire metrics, and the Prometheus names on `METRICS_ADDR` (`db_client_operation_duration_seconds`, `db_client_connection_count`, `_max`, `_idle_min`, `_timeouts_total`, `_wait_time_seconds`, `_pending_requests`).
     - `TestDatabaseTelemetry` (integration) runs a real request through `httpserver.NewInstrumented` against PostgreSQL: `BEGIN`, `GetProduct`, `SELECT` and `COMMIT` spans are children of the `GET /api/v1/probe/{id}` server span; a secret argument, also present in the URL, appears nowhere in spans or metrics; the pool gauges report `max=4` from the URL; and a pool opened with `pool_max_conns=3&pool_min_conns=1` has that size.
     - `check` and `integration --race` passed. The full browser suite (`npm run test:e2e`, 344 tests) passed with the instrumented pool in `main.go`, run pinned to CPUs 0–7 and 10–31 (`taskset`) because CPUs 8–9 on this machine are faulty. An earlier unpinned run, alongside `integration`, timed out once in `milestone9-acceptance.spec.ts:107`; that test also failed 1 of 8 isolated runs without the task 4 changes, at the same assertion.
5. [x] **Business metrics and mail spans.** Add counters for orders and payment results, unknown checkout outcomes, guest sessions created, rate-limit rejections by limiter, and email failures. Add spans around SMTP sends.
   - **Done when:** each counter has a test that increments it, and the data rules in MILESTONE_15.md hold.
   - **Result (2026-11-08):**
     - New `platform/metrics` recorder with six counters: `ecom.orders.created`, `ecom.payment.results`, `ecom.checkout.unknown_outcomes`, `ecom.guest.sessions.created`, `ecom.rate_limit.rejections` and `ecom.email.deliveries`. Labels and what is counted are in [DECISIONS.md](DECISIONS.md#observability-milestone-15). `main.go` builds it from the telemetry meter provider and passes it to auth, the guest handlers, checkout and the mail sender.
     - Each in-process limiter now has a fixed name. `email.Instrument` adds an `smtp send` client span under the request span.
     - Tests that increment each counter: `metrics` (every method, zero series, nil safety, Prometheus names), `auth` (throttled and capacity rejections; handler limiter names), `checkout` (each response kind through `observe`; guest checkout limiter names), `email` (span nesting, sent and failed deliveries, no address, subject or body recorded, disabled mail untouched), and `TestBusinessMetrics` (integration: two account checkouts, accept and reject, and a guest checkout with its session, with replays adding nothing and no contact or product ID in any label).
     - `check` and `integration --race` passed. The full browser suite (`npm run test:e2e`, 344 tests) passed with the recorder wired into `main.go`. Both suites ran one at a time, pinned to CPUs 0–7 and 10–31.
6. [x] **Contract and export check.**
   - Write `backend/OBSERVABILITY_CONTRACT.md`: every span name, metric name and label, and log field. Add a test that fails when a registered metric is missing from it.
   - Run `serve-https` with telemetry pointed at a pinned Collector that uses only the `debug` exporter. Run the HTTPS browser group, and confirm spans and metrics arrive over OTLP and on `METRICS_ADDR`.
   - Measure the latency difference with telemetry on and off, and record the evidence in STATUS.md.
   - **Result (2026-11-09):**
     - [backend/OBSERVABILITY_CONTRACT.md](backend/OBSERVABILITY_CONTRACT.md) (contract version 1) lists delivery, resource, spans, the 15 metrics with OTel and Prometheus names, label values, runtime metrics, suggested PromQL, log events and fields, and what is never recorded.
     - `TestContractListsEveryMetric` (`platform/telemetry`, runs in `check`) builds every instrument through the constructors `main.go` uses and fails on a missing row, a stale row or a wrong Prometheus name. Removing a row and renaming a Prometheus name were both caught.
     - `scripts/telemetry-check/collector.yaml` configures the pinned debug Collector; the steps are in [OPERATIONS.md](backend/OPERATIONS.md#telemetry-export-check). A scripted browser journey against `serve-https` (two guest checkouts) produced 80 traces over OTLP, with the checkout as one 54-span trace, and the Collector scraped all 15 contract metric families. The HTTPS browser group cannot export, because the harness drops telemetry settings, so it stays a regression gate in task 7 ([DECISIONS.md](DECISIONS.md#observability-milestone-15)).
     - Overhead: about 5–50 µs per request on the mean and 0.1–0.15 ms at p99 on sub-millisecond requests; an unreachable Collector cost no more than a working one. Evidence: [STATUS.md](STATUS.md#telemetry-export-check-and-overhead-m15-task-6-2026-11-09).
7. [x] **Milestone acceptance.**
   - Run `check`, `integration --race`, `npm run typecheck`, `npm test`, `npm run build`, the full `npm run test:e2e` and the HTTPS browser group.
   - Update [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md), [backend/OPERATIONS.md](backend/OPERATIONS.md), [DEVELOPMENT.md](DEVELOPMENT.md), [backend/TESTING.md](backend/TESTING.md) and [STATUS.md](STATUS.md).
   - **Done when:** every gate in [MILESTONE_15.md](MILESTONE_15.md#release-gates-for-m15) passes.
   - **Result (2026-11-09):**
     - Every gate passed; the gate-by-gate evidence is in [STATUS.md](STATUS.md#m15-acceptance-task-7-2026-11-09). All commands exited 0: `check`, `integration --race`, typecheck, 1,373 unit tests, build, 348/348 browser tests (275 s with 4 workers) and 10/10 HTTPS tests.
     - Gate 2 had no direct test, so `TestCheckoutTraces` (integration) was added: an account checkout and a guest checkout each form one trace from the server span through their query spans, plus the guest receipt's `smtp send` span, with no personal data in any span.
     - Gate 1 was also checked by hand: with nothing set, the API held one listener and one PostgreSQL connection and logged no telemetry line.
     - Docs: ARCHITECTURE (telemetry packages, dependencies, pool size, a Telemetry section), OPERATIONS (contract link and export check, from task 6), DEVELOPMENT and both TESTING files (telemetry tests, 4-worker browser harness, Node 24, CPU pinning), FIXTURES (migration template) and STATUS. The browser-harness speed-up had edited the original `docs/frontend/` files; those edits were moved into `docs/updated/` and the originals restored.

Acceptance: with telemetry configured, every request, query and business outcome is emitted as traces, metrics and linked logs according to the published contract; with it unset, the application behaves exactly as before.

## Milestone 16 — Final baseline release

Status: **done** — `v1.0.0` tagged locally (2026-11-09). Design: [MILESTONE_16.md](MILESTONE_16.md).

1. [x] **Choose the packaging options.** Decide on the migration job, runtime base image and secret handling, and record them in DECISIONS.md.
   - **Result (2026-11-09):** migrations are embedded in a `cmd/migrate` binary (goose as a library) in the same image and run as a forward-only one-off job with the migrator credentials; readiness will accept a minimum schema version; the runtime is distroless `static-debian12:nonroot` with no in-container health check; Compose secrets come from an ignored env file per service; the M14 local CA is mounted read-only and the database service is named `postgres`. Details: [DECISIONS.md](DECISIONS.md#packaging-milestone-16).
2. [x] **Migrate command and readiness.** Add `cmd/migrate`: the SQL in `backend/migrations` embedded with `//go:embed`, applied through goose as a pinned Go library, holding a PostgreSQL advisory lock. It supports only `up` and a read-only `status`, reads its database URL from the environment and never logs it. Change `/health/ready` to pass at the build's minimum schema version (13) or above. Decide whether the fixture tool, `dev.sh migrate` and the integration tests move to the embedded files or keep the goose CLI.
   - **Done when:** against a fresh test database, `migrate up` applies all 13 migrations and a second run changes nothing; two concurrent runs apply each migration once; a failing migration exits nonzero and leaves the version unchanged; readiness passes at version 13 and at 14, and fails at 12.
   - **Verify:** `check` and `integration --race`.
   - **Result (2026-11-09):** `backend/cmd/migrate` (logic in `internal/migratecmd`) embeds the SQL through `backend/embed.go` and runs goose v3.28.0 as a library with a PostgreSQL session advisory lock. `up` prints one JSON line per applied migration and a summary; `status` reads in a read-only transaction. It reads `APP_ENV` and `DATABASE_URL` with the API's URL rules and reports connection failures without the URL, user or host. `database.MinSchemaVersion` (13) replaces the exact `SchemaVersion`, and readiness fails only below it. The fixture tool, `dev.sh migrate`, `check` and the existing test helper keep the goose CLI ([DECISIONS.md](DECISIONS.md#packaging-milestone-16)). New tests in `migrate_command_test.go`: a fresh database goes 0→13 and a second run applies nothing, `status` leaves a fresh database untouched, two concurrent runs apply each version once, a failing migration 14 exits nonzero with version 13 and its table rolled back, readiness fails at 12 and passes at 13 and 14, and the 13-migration build is a no-op against a version-14 schema. `check` and `integration --race` pass.
3. [x] **Application image.** A root `Dockerfile` with three stages:
   - **Frontend:** pinned Node 24.20.0; `npm ci`, then the same-origin build (`npm run build:same-origin`), as `serve-https` uses.
   - **Go:** pinned Go 1.27.3 (the version every gate ran on); `CGO_ENABLED=0 go build -trimpath` for `api`, `migrate` and `reconcile`. The fixtures tool is not shipped.
   - **Runtime:** distroless `static-debian12:nonroot`, running as user 65532, with the three binaries and `dist`. `STATIC_DIR` points at `dist`. No secrets or certificates. The commit and version arrive as build arguments and become OCI labels (`org.opencontainers.image.revision`, `.version`), because `.git` is not in the build context.
   - Pin every base image by digest under the two-week rule. A root `.dockerignore` excludes `.git`, `.cache/`, `.env*`, `node_modules/`, `frontend/dist`, fixture bundles and test output.
   - **Done when:** the image builds from a clean checkout; it runs as 65532; its file list holds only the three binaries, `dist` and the base image's files (no `.env`, `.cache`, bundles or keys); and a short run of `api` answers `/health/live`.
   - **Result (2026-11-09):** root [`Dockerfile`](../../Dockerfile) and allowlist [`.dockerignore`](../../.dockerignore). The runtime base became distroless **`static-debian13`**, because `static-debian12` stopped receiving images on 2026-08-21; the builders are `node:24.20.0-bookworm-slim` and `golang:1.27.3-bookworm`. All three are pinned by digest and at least two weeks old ([DECISIONS.md](DECISIONS.md#packaging-milestone-16)). Built from an export of the tracked and new files (no `.env`, `.cache` or `node_modules`) as `ecom:m16-dev`, 46.8 MB; the frontend stage ran the typecheck and same-origin build. Checks: `Config.User` is `65532:65532` and `docker top` shows UID 65532; compared with the base image, the file list adds only `/usr/local/bin/{api,migrate,reconcile}` (root-owned, 0755) and `/app/dist` (index, 28 assets, 5 fixture SVGs), with no `.env`, `.pem`, `.key`, bundle, `.cache`, `.git` or `node_modules` path; the context sent from the real working tree held only `go.mod`, `go.sum`, `backend`, `frontend` sources and `fixtures/public` (3.4 MB, no secrets). A short run (`--network host`, local mode, `127.0.0.1:18095`, the development database) answered `/health/live` 200, `/health/ready` 200, the SPA at `/` and a deep link, a fixture SVG and `/api/v1/products`; `migrate status` in the image reported version 13 ready, and `reconcile --help` printed its flags. The labels carry `version` and `revision` from the build arguments.
4. [x] **Compose deployment profile.** A separate Compose file; the default dev Compose is unchanged.
   - Services: `postgres` (TLS with the M14 certificates, health-checked with `pg_isready`), `migrate` (must complete successfully), then `api`.
   - The API runs in **production mode**, because local mode only allows loopback listeners, which a published container port cannot reach. Production mode requires `MAIL_MODE=smtp`, so the profile adds a local mail-capture container with TLS. No mail leaves the host.
   - Secrets come from an ignored env file per service; certificates are mounted read-only; telemetry is off unless `OTEL_*` and `METRICS_ADDR` are set.
   - **Done when:** `docker compose up` on an empty volume reaches a ready API on `https://localhost:8443`, with `migrate` exited 0 first.
   - **Result (2026-11-09):** [`compose.deploy.yaml`](../../compose.deploy.yaml) (project `ecom-deploy`), started with `bash scripts/dev.sh deploy` after `certs.sh` (now also issuing `mail.pem`) and `init-deploy-env`. Services: a one-shot `certs` copy into per-consumer volumes owned by 65532, `postgres` requiring TLS (`pg_hba.deploy.conf`), `migrate`, `api`, and Mailpit 1.32.0 as `mail` with STARTTLS. Pinned images and reasons: [DECISIONS.md](DECISIONS.md#packaging-milestone-16). On four new, empty volumes the stack was ready in about 7 s: `certs` and `migrate` exited 0 (13 applied, version 13), then `api` started in production mode with TLS; `/health/live`, `/health/ready`, `/` and `/api/v1/products` returned 200 over HTTPS verified with `ca.pem`. `api` and `mail` run as UID 65532; the image labels carry the commit. A `sslmode=disable` client was refused ("no encryption"); with TLS it reached password authentication. A registered user's verification request returned `delivery: accepted`, and Mailpit captured "Verify your Commerce Lab email" from `no-reply@example.test`. After `deploy-down` and `deploy`, `migrate` applied 0 and the 3 test users remained. The development `compose.yaml` and its `ecom-postgres` container were untouched.
5. [x] **Deployment verification.** Against an owned test database in the Compose deployment:
   - `/health/ready` passes over HTTPS.
   - A scripted headless Chromium journey (sign-in, account checkout, guest checkout accepted and rejected, a mailed link from the capture container) passes against the container. The HTTPS browser group itself cannot target a container: its harness starts its own API for every test.
   - The recovery CLI runs inside the deployment (`reconcile --dry-run`, then `--apply` on a stranded order).
   - A restart of the whole profile keeps the data.
   - With `OTEL_*` and `METRICS_ADDR` set, the M15 debug Collector receives spans and scrapes the metrics listener; with them unset, nothing is exported.
   - **Result (2026-11-09):** `bash scripts/dev.sh deploy-verify` ([`scripts/deploy-verify.sh`](../../scripts/deploy-verify.sh)) runs every check against its own Compose project, `ecom-deploy-verify`, on new volumes that it removes at the end (`KEEP=1` leaves them). The everyday `ecom-deploy` volumes and the development database are not touched. Steps:
     1. On empty volumes, `migrate` exits 0 after applying 13 migrations, then the API starts.
     2. `/health/live` and `/health/ready` return 200 over HTTPS, with the chain verified against `ca.pem` by curl.
     3. One product is seeded as `ecom_migrator` (50 units).
     4. A headless Chromium journey ([`tests/deploy/journey.spec.ts`](../../frontend/tests/deploy/journey.spec.ts), its own `playwright.deploy.config.ts`, no harness) runs against the container: sign-in through the UI, the verification email read from Mailpit and its `#token` link confirmed, an account checkout reaching "Confirmed", then guest checkouts accepted and rejected, with both mailed guest order links opened and showing the right status.
     5. A host-side helper (`backend/internal/deploycheck`, build tag `deploycheck`) creates a pending order through `checkout.Service.CreatePending` and expires its reservation. Inside the deployment, `reconcile --dry-run` lists it and leaves it `pending_payment`, `--apply` settles it (`confirmed`), and a second dry-run visits nothing.
     6. `down` and `up` of the whole profile keep the data (users/orders/products 1/4/1), `migrate` applies 0, and the customer still signs in.
     7. With the `telemetry` Compose profile's debug Collector running but the API's settings unset, there is no `telemetry configured` log, no span and no scrape. With `compose.deploy.telemetry.yaml` (`OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318`, `METRICS_ADDR=0.0.0.0:9464`), the Collector receives `GET /api/v1/products` spans and scrapes `http_server_request_duration_seconds` and `ecom_orders_created_total`, and the customer's email does not appear.
     All 8 checks passed on two consecutive runs (about 51 s each). `check` passes with the new package, and the frontend typecheck and 1374 unit tests pass, including a new check that keeps the deploy journey out of every npm browser group. Choices: [DECISIONS.md](DECISIONS.md#packaging-milestone-16).
6. [x] **Release evidence.** Record tool versions, image digests (application, `postgres:16-alpine`, builder and runtime bases), the commit, schema 13, fixture version 1, OpenAPI 1.7.0, observability contract version 1, test results and run instructions for a fresh machine.
   - **Result (2026-11-09):** [RELEASE.md](RELEASE.md) holds the evidence and the fresh-machine instructions. [`scripts/release-evidence.sh 1.0.0`](../../scripts/release-evidence.sh) builds `ecom:1.0.0` from `git archive HEAD` (version and commit as labels), checks user 65532, the labels and the file list against the distroless base (only `/usr/local/bin/{api,migrate,reconcile}` and 34 `dist` files added), and prints the commit, image ID, base and service image digests, schema 13, OpenAPI 1.7.0, fixture version 1, contract version 1 and the host tool versions, all read from the commit. Pre-tag run on `e8bef0e`: image ID `sha256:e51ebd72…`, 46.8 MB. Builds are not bit-for-bit reproducible (an earlier build of the same commit was `sha256:92b64cbe…`), so the script refuses to replace an existing release tag. `dev.sh deploy` now runs a prebuilt `ECOM_IMAGE` with `--no-build` and refuses a missing one. A new `git clone` with new certificates and env files followed the instructions to a ready API (Compose project `ecom-fresh`, removed afterwards), and `ECOM_IMAGE=ecom:1.0.0` ran the release image unchanged. Open: the image is not in a registry, so there is no manifest digest yet; the portfolio plan publishes `v1.0.0` to GHCR ([RELEASE.md](RELEASE.md#known-limits)).
7. [x] **Tag the baseline.** Run the full regression (`check`, `integration --race`, frontend checks, the full browser suite and the HTTPS group), then create an annotated tag on the verified commit and update STATUS.md.
   - **Result (2026-11-09):** the sequential regression on `483f2b1` passed `check`, `integration --race`, typecheck, 1,374 unit tests, the build, 348/348 browser tests and 10/10 HTTPS tests. `deploy-verify` failed once: Chromium aborted the first login with `net::ERR_NETWORK_CHANGED` while Docker's new interfaces finished IPv6 duplicate address detection. The script now waits for those interfaces to settle before the browser starts and keeps diagnostics on failure; 8/8 consecutive full runs then passed ([STATUS.md](STATUS.md#m16-regression-task-7-2026-11-09)). The annotated tag `v1.0.0` is local by decision (no registry push); its annotation records the image ID that `release-evidence.sh` built at the tag ([RELEASE.md](RELEASE.md)).

Acceptance: a fresh machine can run the tagged release from the documented instructions, and every gate in [MILESTONE_16.md](MILESTONE_16.md) has recorded evidence.

## Milestone 17 — CDN frontend and load-balanced API

Status: **in progress**; follows the M16 tag. Design and decisions: [MILESTONE_17.md](MILESTONE_17.md). The single-host mode from M14–M16 must keep working throughout. Nothing touches AWS until task 5, and only with the owner's go-ahead (it costs money).

1. [x] **Record the decisions** (2026-11-12). Terraform development root with layer modules, EC2 capacity provider, optional domain, ALB re-encryption, `CloudFront-Viewer-Address`, PostgreSQL limits, init-container migrations, Mailpit on ECS, local state. Process-local state audit in MILESTONE_17.md; summary in DECISIONS.md.
2. [ ] **Trusted client IP.** One helper used by `auth.allowPeer` and the guest admission and bootstrap limits. It reads `CloudFront-Viewer-Address` only with `TRUSTED_PROXY=cloudfront` and falls back to `RemoteAddr` otherwise (local mode).
   - **Done when:** forged headers have no effect without the setting, and the header is used with it; an invalid setting is refused.
   - **Verify:** unit and config tests, plus `check`.
3. [ ] **Shared rate limits.** Migration `00014` adds a PostgreSQL counter table behind the existing `auth.RequestLimiter` and guest `limiter` interfaces. Concurrency slots stay per task.
   - **Done when:** two limiter instances sharing a database enforce one limit.
   - **Verify:** integration test with two instances, `integration --race`, and the full browser suite.
4. [ ] **Terraform modules and the development root.** `infrastructure/terraform/modules/{network,ecs-cluster,database,service,edge}` and `environments/development` (README with cost, apply, verify and destroy; example S3 backend; both domain modes). The image is built and pushed to ECR by digest; the frontend is extracted from it and published to S3 (assets, fixtures, then `index.html`; previous assets kept).
   - **Done when:** `terraform fmt -check` and `terraform validate` pass, and no `.env`, fixture bundle or source map can reach the bucket.
5. [ ] **Verification against AWS** (both domain modes, owner's go-ahead first). Release gates 2–6 from MILESTONE_17.md; the HTTPS browser group against the CloudFront URL; forged headers and direct ALB access refused; a shared limit across two tasks and a rolling deploy; a task stopped under traffic; `reconcile` as a one-off task; a second `plan` shows no drift.
6. [ ] **Evidence, teardown and tag.** Record the image digest, Terraform and provider versions and resource identifiers (no secrets); `terraform destroy` removes everything (cost noted); full local regression; HOW_TO.md and STATUS.md updated; tag `v1.1.0`.

Acceptance: the application runs from a CDN and two or more load-balanced API tasks behind one HTTPS origin, with limits that hold per real viewer across tasks, and every gate in [MILESTONE_17.md](MILESTONE_17.md) has recorded evidence.
