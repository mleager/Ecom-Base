# Project status

**As of 2026-11-10.** Milestones 1–16 are complete; release `v1.0.0` is a local annotated tag ([RELEASE.md](RELEASE.md)). Next is Milestone 17 (CDN frontend and load-balanced API). Task list: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md).

## Milestones

| # | Milestone | Outcome | State |
|---|---|---|---|
| 1 | Core database and services | Schema, toolchain, identity, accounts, catalog, cart | Done |
| 2 | Transactional orders | Atomic T1: snapshots, reservations, idempotency, cart consumption | Done |
| 3 | Simulated payment | Processing claim, deterministic simulator, T2 settlement, cancellation, order HTTP | Done |
| 4 | Failure recovery | Recovery CLI, diagnostics, concurrency and crash tests | Done |
| 5 | Backend readiness | Architecture docs, runbooks, consolidated evidence | Done |
| 6 | Frontend design and API alignment | Routes, tooling pins, fixtures, product search and admin read APIs | Done |
| 7 | Frontend foundation and auth | Shell, typed API client, session lifecycle, protected routes | Done |
| 8 | Storefront and catalog | Product list and details, search, pagination | Done |
| 9 | Account, addresses, cart | Profile, password/email security, password reset, addresses, cart | Done |
| 10 | Checkout and orders | Checkout with recovery, order history, observation, cancellation | Done |
| 11 | Administration and hardening | Product and stock admin, accessibility, full browser regression | Done |
| 12 | Visual design | Shared dark visual system across all pages | Done |
| 13 | Shopping revision and guest checkout | Tailwind/shadcn UI, Quick View, mini-cart, guest purchase and recovery, admin search | Done (GAP-08 closed) |
| 14 | Production serving and HTTPS | API serves the SPA from one HTTPS origin; database TLS; production-mode smoke | Done (accepted 2026-11-07; see [M14 acceptance](#m14-acceptance-task-10-2026-11-07)) |
| 15 | Observability | Built-in OpenTelemetry traces and metrics, logs linked to traces, configurable pool size, published telemetry contract (the stack is Project 4) | Done (accepted 2026-11-09; see [M15 acceptance](#m15-acceptance-task-7-2026-11-09)) |
| 16 | Final baseline release | Application image, Compose deployment, release evidence, tag | Done: local tag `v1.0.0` (2026-11-09; not published to a registry). Evidence: [RELEASE.md](RELEASE.md). See [MILESTONE_16.md](MILESTONE_16.md) |
| 17 | CDN frontend and load-balanced API | SPA on S3 + CloudFront, API tasks behind an ALB, trusted client IP, shared rate limits | **Planned**. See [MILESTONE_17.md](MILESTONE_17.md) |

## Current facts

| Item | Value |
|---|---|
| Schema / readiness version | 13 (migrations `00001`–`00013`), 21 tables plus goose metadata. Readiness accepts version 13 or newer (M16 task 2). |
| OpenAPI | 1.7.0: 61 business operations (23 guest) + 3 operational routes (`/health/live`, `/health/ready`, `/metrics`) |
| Fixture data | Version 1: 36 products (34 active, 2 retired), 3 accounts |
| Frontend routes | 27 browser routes, including 4 guest routes |
| Browser tests | 348 Chromium tests across 46 spec files |
| Frontend unit/component tests | 1,374 across 47 suites |
| Telemetry contract | Version 1: 15 metrics, 3 span types (request, query, SMTP), 11 log events ([backend/OBSERVABILITY_CONTRACT.md](backend/OBSERVABILITY_CONTRACT.md)) |

## Environment (Ubuntu)

The project moved from Windows to Ubuntu. Current toolchain:

| Tool | Installed | Project pin | Notes |
|---|---|---|---|
| Go | 1.27.3 | `go 1.26.0` in `go.mod` (M15 task 2) | Works. `GOTOOLCHAIN=local` uses the installed newer Go; no download occurs. |
| goose | 3.28.0 | 3.28.0 (Go module, M16 task 2) | `cmd/migrate` imports the library; the installed CLI still serves `dev.sh migrate`, `check` and fixtures. |
| sqlc | 1.31.1 | 1.31.1 | Matches. |
| govulncheck | 1.9.0 | 1.9.0 | Runs in `check` (M15 task 1); needs network access to vuln.go.dev. |
| Node / npm | 24.20.0 / 11.19.0 | Exact (`engine-strict`) | Also installed: nvm's Node 22.13.1, which non-interactive shells picked up on 2026-11-09. Under Node 22, `npm test` fails to start most Vitest workers (an `undici` load error); run `nvm use 24.20.0` first. |
| PostgreSQL | `postgres:16-alpine` | Moving tag | Only container in use. |
| Docker / Buildx | 28.3.3 / 0.26.1 | — | Builds the M16 application image (BuildKit cache mounts, no `# syntax` line, so no extra frontend image is pulled). |
| Playwright Chromium | Revision 1248 (pinned by Playwright 1.64.1) | — | Linux build in `~/.cache/ms-playwright` (the default path). `.cache/playwright` holds only the Windows build. |

Windows-only helpers moved to `scripts/win64/`. Bash entry points are `scripts/dev.sh`, `scripts/certs.sh`, `scripts/fixture.sh` and `scripts/connect.sh`.

## Verification on Ubuntu

| Gate | Result |
|---|---|
| `bash scripts/dev.sh check` (gofmt, sqlc vet/generate, goose validate, go vet, govulncheck, go test) | Pass (2026-11-09, M16 task 7 regression; no reachable vulnerabilities) |
| `bash scripts/dev.sh integration --race` | Pass (219 s, 2026-11-09, M16 task 7 regression) |
| `bash scripts/dev.sh database-tls-check` (with `database-tls`) | Pass: `verify-full` by host name and IP, API pool over TLS, wrong host and untrusted CA refused (2026-11-07) |
| `npm run typecheck`, `npm test`, `npm run build` | Pass (1,374 tests in 47 suites, Node 24.20.0, 2026-11-09, M16 task 7 regression). One admin test is intermittent (see [Known limits](#known-limits)); it passed in the regression. |
| `npm run test:e2e` | Pass, 348/348 (4 min 43 s with 4 workers, 2026-11-09, M16 task 7 regression) |
| `npm run test:e2e:https` | Pass, 10/10 (56 s, 2026-11-09, M16 task 7 regression) |
| `bash scripts/dev.sh deploy-verify` | Pass, 8/8 consecutive full runs after the network-settle fix (2026-11-09, M16 task 7); see [M16 regression](#m16-regression-task-7-2026-11-09) |

The first Ubuntu e2e runs crashed late in the suite. The cause was an unstable CPU core on the host (logical CPUs 8–9), confirmed by pinning tests away from those cores. It was not a code or test defect. Heavy suites now run pinned with `taskset -c 0-7,10-31`, and the browser and integration suites never run at the same time. The old WSL clock-sync workaround described in older docs no longer applies.

### Local HTTPS smoke (M14 task 7, 2026-11-07)

`bash scripts/dev.sh serve-https <fixture>` with a `fixtures-https` fixture. The certificate chain was checked with `curl --cacert .cache/certs/ca.pem`. The browser journey ran in Playwright's headless Chromium with `ignoreHTTPSErrors`, because it does not read the desktop trust store. Every step passed:

| Check | Result |
|---|---|
| Home page from the API origin, fixture images load, no cross-origin requests | Pass |
| Deep link and reload: product detail, guest order, account, order detail, admin pages | Pass |
| Guest checkout: simulated acceptance and simulated rejection | Pass |
| Email-link page (`/verify-email#token=…`) renders | Pass |
| Customer sign-in; session restored after reload | Pass |
| Account checkout: simulated acceptance and simulated rejection | Pass |
| Order history and detail | Pass |
| Guest and refresh cookies: `Secure`, `HttpOnly`, `SameSite=Strict` | Pass |
| Sign-out returns 204 and removes `ecom_refresh`; admin sign-in; admin products and inventory | Pass |
| Unknown `/api/v1` path returns JSON; `index.html` has `no-cache` and the HTML security headers; no HSTS in local mode | Pass |

Not yet done: the same walk-through in a desktop browser that trusts `ca.pem`.

The first smoke runs also logged a few `503` responses on `GET /guest/cart` and one `500` on `GET /cart` that the page never received. These were requests the browser cancelled during navigation, which the handlers mapped from `context.Canceled`. The request log now records such requests as `499` with `client_closed` and `handler_status` (see [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md)). Unit tests cancel requests over HTTP/1.1 and HTTP/2 over TLS to check this.

**Lost add-to-cart click (fixed 2026-11-07).** `guest-contract.spec.ts:34` failed intermittently: two tabs click *Add to cart* together, and both badges must show 2. The cause was a real lost update, not test timing.
- The add from one tab reached the other tab as a peer notice, which started a second cart read just as that tab's own first read finished.
- `CartController.change()` refuses to write during a read, so the click was dropped with no message, and the server cart ended at quantity 1.
- Adds now go through `changeAfterReads()`, which waits for reads in flight, then sends once.
- Before the fix it failed 4 of 8 isolated runs; after it, 20 of 20 pass. New unit tests are in `CartController.test.ts`.

A browser that had already used the HTTP stack on `localhost` could not create a guest cart over `serve-https` until the guest session was cleared. Its old `ecom_guest` cookie was also sent to port 8443, because cookies ignore ports. Secure-mode cookies are now named `__Secure-ecom_guest`, `__Secure-ecom_guest_recovery` and `__Secure-ecom_refresh`. This was verified by seeding a stale plain `ecom_guest` cookie: the patched HTTPS server started a new guest session, and Add to cart worked (see [backend/GUEST_COMMERCE.md](backend/GUEST_COMMERCE.md#cookie-names-over-https)).

### Production-mode smoke (M14 task 9, 2026-11-07)

The built API ran with `APP_ENV=production`, `HTTP_ADDR=127.0.0.1:8443`, `FRONTEND_ORIGIN=https://localhost:8443`, the local certificates, `STATIC_DIR=frontend/dist` (same-origin build) and `MAIL_MODE=smtp` with the SMTP settings from private `.env`. The database was a `fixtures-https` fixture, reached with `sslmode=verify-full&sslrootcert=.cache/certs/ca.pem` against PostgreSQL started by `bash scripts/dev.sh database-tls`. The journey ran in headless Chromium with `ignoreHTTPSErrors`. No secret was printed or stored outside `.env`; the test account's password was generated for the run and never written down.

| Check | Result |
|---|---|
| API connections to PostgreSQL use TLS (`pg_stat_ssl`: TLSv1.3) | Pass |
| `/health/live` and `/health/ready` return 200 over HTTPS (`curl --cacert`) | Pass |
| `Strict-Transport-Security: max-age=31536000` on the SPA and API responses | Pass |
| Unknown `/api/v1` path returns a JSON 404 | Pass |
| Product deep link served by the API | Pass |
| Guest cart cookie `__Secure-ecom_guest`: `Secure`, `HttpOnly`, `SameSite=Strict` | Pass |
| Registration with `ECOM_MAIL_TEST_RECIPIENT`; sign-in sets `__Secure-ecom_refresh` with the same attributes | Pass |
| Verification request: the real SMTP server accepted the message (second attempt, see below) | Pass |
| The received email's link points to `https://localhost:8443/verify-email#token=…`, opens, removes the token from the address bar, and completes verification | Pass |
| Verified state persists after reload (`email_verified: true`) | Pass |

The link was taken from the real inbox and opened in the headless browser, not a desktop browser. Production mode sends HSTS for `localhost`, and a desktop browser that stores it may then force HTTPS on other `localhost` ports, such as the Vite dev server.

**First send unconfirmed.** The first verification request returned 202 with delivery `unconfirmed` (log: `security email delivery unconfirmed`). The token was valid, so the SMTP exchange itself failed. A standalone probe with the same settings and message shape then completed in under 0.9 s three times (two probe messages reached the inbox), and the retry through the API was accepted. The cause is not proven; see the SMTP limit below.

### M14 acceptance (task 10, 2026-11-07)

One sequential run on this host: `check`, `integration --race`, `database-tls` + `database-tls-check` (PostgreSQL then returned to the default), `npm run typecheck`, `npm test`, `npm run build`, the full `npm run test:e2e` and `npm run test:e2e:https`. Every command exited 0. `check` ran gofmt, sqlc, goose validate and vet fresh; its `go test` results came from Go's test cache, which reuses a result only when sources and inputs are unchanged since a fresh pass.

| Gate ([MILESTONE_14.md](MILESTONE_14.md#release-gates-for-m14)) | Evidence | Result |
|---|---|---|
| 1. Static serving and fallback | `httpserver` unit tests; HTTPS group `routing.spec.ts` (deep links and reloads per route family, email-link pages, JSON 404s, cache and security headers) | Pass |
| 2. TLS | `config` and `httpserver` unit tests (half-configured TLS refused, HSTS only in production with TLS); HTTPS group cookie checks; production smoke (HSTS present) and local smoke (no HSTS) | Pass |
| 3. Database TLS | `TestDatabaseTLS`: all five subtests | Pass |
| 4. Browser behavior over HTTPS | `npm run test:e2e:https` 10/10 | Pass |
| 5. Production mode | [Production-mode smoke](#production-mode-smoke-m14-task-9-2026-11-07): real SMTP, link opened and completed on HTTPS | Pass |
| 6. Regression | `check`, `integration --race`, 1,371 unit tests, typecheck, build, 348/348 browser tests | Pass |

Limits carried forward are listed below. None blocks the gates.

### M15 acceptance (task 7, 2026-11-09)

One sequential run on this host, pinned to CPUs 0–7 and 10–31: `check`, `integration --race`, `npm run typecheck`, `npm test`, `npm run build` (Node 24.20.0), the full `npm run test:e2e` and `npm run test:e2e:https`. Every command exited 0. `integration --race` ran a second time after `TestCheckoutTraces` was added for gate 2, and passed.

| Gate ([MILESTONE_15.md](MILESTONE_15.md#release-gates-for-m15)) | Evidence | Result |
|---|---|---|
| 1. Off by default | `TestOffByDefault` (no listener, no connection, no extra log line) and `TestOffLeavesLogsUnchanged`. Every suite ran with telemetry unset; browser-test APIs drop `METRICS_ADDR` and `OTEL_*`. `dev.sh run` with nothing set held one listener (`HTTP_ADDR`) and one connection (PostgreSQL), and logged only `API starting` and `http request` lines. | Pass |
| 2. Traces | `TestCheckoutTraces` (integration, in-memory exporter): an account checkout and a guest checkout each form one trace, from the `POST` server span through its query spans, plus one `smtp send` span for the guest receipt; no email, name, address, password, token, cookie, idempotency key or mail subject in any span. `TestDatabaseTelemetry` proves query arguments are never exported. | Pass |
| 3. Metrics | `TestMetricsListener` and the `TestPrometheusNames` tests (RED, pool, runtime and business families on `METRICS_ADDR`); a test per business counter plus `TestBusinessMetrics`; `TestUnknownPathsAddNoSeries` (300 odd requests, five fixed series). | Pass |
| 4. Logs | `TestLogHandler` (trace and span IDs inside a span) and `TestOffLeavesLogsUnchanged`. | Pass |
| 5. Pool size | `TestPoolSizeFollowsURL` and `TestDatabaseTelemetry` (`pool_max_conns=3&pool_min_conns=1`; default 10). | Pass |
| 6. Export check | [Export check and overhead](#telemetry-export-check-and-overhead-m15-task-6-2026-11-09): 80 traces over OTLP and all 15 metric families scraped from a `serve-https` browser journey; `TestUnreachableEndpointNeverDelaysRequests`, and an unreachable Collector measured no slower than a working one; overhead recorded. | Pass |
| 7. Contract | [OBSERVABILITY_CONTRACT.md](backend/OBSERVABILITY_CONTRACT.md) version 1; `TestContractListsEveryMetric` in `check`. | Pass |
| 8. Regression | `check`, `integration --race`, 1,373 unit tests, typecheck, build, 348/348 browser tests, 10/10 HTTPS tests. | Pass |

### M16 regression (task 7, 2026-11-09)

One sequential run on this host, pinned to CPUs 0–7 and 10–31, on `483f2b1`: `check`, `integration --race`, `npm run typecheck`, `npm test`, `npm run build`, the full `npm run test:e2e` (348/348), `npm run test:e2e:https` (10/10) and `deploy-verify`. Every command exited 0 except `deploy-verify`, whose browser journey timed out waiting for the login response.

- **Cause:** a trace kept with the new `TRACE=1` showed `POST /auth/login` aborted by Chromium with `net::ERR_NETWORK_CHANGED` 1.6 s after the API container started; the API logged a client-closed 499. `docker compose up --wait` returns while the new veth interfaces still hold tentative IPv6 addresses (duplicate address detection, about 1 s); when they become valid, Chromium cancels in-flight requests. It hit 2 of 8 full runs. Looping the journey separately also hit `guest_read` throttling, because every client reaches the container from the Docker gateway address; that was a loop artifact, not the regression failure.
- **Fix:** `deploy-verify.sh` waits until no `veth*`/`br-*` interface has a tentative address before the browser starts (at most 10 s). No retry or longer timeout. Failed runs now keep the API log, and `TRACE=1` the failed test's trace, in `.cache/deploy-verify/`.
- **After the fix:** 8/8 consecutive full runs passed all 8 checks, about 53 s each, none needing the 10 s fallback.

Release evidence, fresh-machine instructions and limits: [RELEASE.md](RELEASE.md).

### Browser harness speed-up (2026-11-08)

The browser suite now runs 4 workers by default, each with its own Vite server and API port. Fixtures are cloned from a migrated template database, and fixture removal overlaps the next test ([frontend/TESTING.md](frontend/TESTING.md#how-the-harness-works), [frontend/FIXTURES.md](frontend/FIXTURES.md#migration-template)). Full runs of 348 tests, pinned:

| Run | Elapsed | Result |
|---|---|---|
| Before (1 worker) | 1,106 s | 348 passed |
| After, six runs | 276–300 s | Five runs all passed; one had a single timeout in `cart.spec.ts:88` that did not recur in 120 isolated repeats or the other runs |
| M15 acceptance | 275 s | 348 passed |

Per-test database setup fell from about 610 ms to about 450 ms under 4-worker load. Changing a migration rebuilds the template, and the next run reuses it.

### Telemetry export check and overhead (M15 task 6, 2026-11-09)

**Export check.** The pinned debug Collector (`otel/opentelemetry-collector:0.164.0`, config `scripts/telemetry-check/collector.yaml`) ran with `--network host`. The API ran in `serve-https` mode on a `fixtures-https` fixture (mail disabled) with `METRICS_ADDR=127.0.0.1:9464` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`. A headless Chromium journey loaded the home page and an unknown page, completed two guest checkouts (simulated acceptance and rejection), opened the guest orders page and requested an unknown API path with a query string. The browser harness drops telemetry settings from its test APIs, so the journey was scripted against `serve-https` instead ([DECISIONS.md](DECISIONS.md#observability-milestone-15)).

| Check | Result |
|---|---|
| Journey completed with no 5xx; the unknown API path returned 404 | Pass |
| Spans arrived over OTLP: 510 spans in 80 traces, every root a `Server` span named `{method} {route}` | Pass |
| The `POST /api/v1/guest/checkout` trace held 54 spans, all parented inside it, from `VerifyGuestSession` and `BEGIN` through `CreatePendingOrder` to `FinishPayment` and `COMMIT` | Pass |
| The Collector's Prometheus receiver scraped all 15 contract metric families, plus `go_*`, `process_*` and `target_info` (`service_name="ecom-api"`) | Pass |
| Counters matched the journey: `ecom_orders_created_total{customer_type="guest"} 2`, one accepted and one rejected payment, one guest session | Pass |
| Routes stayed bounded: SPA pages as `static`, the unknown API path as `unmatched` | Pass |
| No contact email, recipient name, street, city, ZIP, query string or unknown path appeared in the Collector output or on `METRICS_ADDR` | Pass |
| Two query spans ended with `error.type=canceled` under `GET /api/v1/guest/cart`, where the browser navigated away mid-request; the server spans were not errors | As designed |

**Overhead.** Same fixture and `serve-https` build. The API was pinned to CPUs 0–7 and the probe (a small Go client over HTTP/2 with keep-alive) to CPUs 10–15 on an i9-14900K. Each mode was restarted, warmed up, then measured: `GET /api/v1/products/{id}` (1 query, 20,000 requests) and `GET /api/v1/products` (10,000 requests), with 1 and 16 concurrent clients. "On" means traces exported to the running Collector, metrics on `METRICS_ADDR` and a 5 s scrape. "Unreachable" means the same settings with the Collector stopped. No request failed in any run.

| Endpoint, clients | Off (2 runs): mean / p99 | On (2 runs): mean / p99 | Unreachable: mean / p99 |
|---|---|---|---|
| Product, 1 | 0.089–0.091 ms / 0.16 ms | 0.095–0.096 ms / 0.26 ms | 0.090 ms / 0.24 ms |
| List, 1 | 0.181–0.189 ms / 0.35–0.36 ms | 0.185–0.201 ms / 0.42–0.43 ms | 0.192 ms / 0.41 ms |
| Product, 16 | 0.318–0.319 ms / 0.73–0.74 ms | 0.353 ms / 0.87–0.89 ms | 0.356 ms / 0.82 ms |
| List, 16 | 0.586–0.597 ms / 1.13–1.14 ms | 0.614–0.635 ms / 1.21–1.30 ms | 0.602 ms / 1.16 ms |

- Telemetry adds about 5–50 µs per request on the mean and about 0.1–0.15 ms at p99. On these very cheap requests that is 2–11 % of latency; at 16 clients throughput fell from about 50,000 to 45,000 requests per second on the product endpoint.
- An unreachable Collector cost no more than a working one. The API logged one `telemetry export failed` line and kept serving.
- Requests with many queries carry one span per query, so a checkout (about 50 spans) costs more in absolute terms. It was not measured separately; it remains small next to the checkout's own database work.

## Known limits

- The whole SMTP exchange has a fixed 2 s budget with no retry ([backend/ACCOUNT_SECURITY.md](backend/ACCOUNT_SECURITY.md)). In the production-mode smoke the first send after startup was reported unconfirmed, and the retry succeeded. The user sees "unconfirmed" and can send again; a slow provider could hit this more often.
- The Vitest case `EditProductPage.test.tsx` › "unknown save outcome stays blocked until a successful explicit read and fresh edit" fails about 1 run in 10 (seen 2026-11-07: the description field still reads `Description` where ` Changed description ` was typed). It is unrelated to the cart and HTTPS work and not yet diagnosed.
- HTTPS was checked in headless Chromium with `ignoreHTTPSErrors`, plus `curl --cacert` for the certificate chain. A walk-through in a desktop browser that trusts `ca.pem` has not been done.
- Production mode was proven on one host with the local CA and loopback addresses. A real domain, public certificates, a non-loopback bind and the HTTP-to-HTTPS redirect are left to later milestones (M16, M17).
- Verification is Chromium-only on one host. Other engines, assistive technology and physical devices are not certified.
- The largest JS chunk (about 433 kB) is close to Vite's default 500 kB warning threshold.

## Repository cleanup candidates

These files are leftovers from earlier work. Review them before release; nothing has been removed.

| File | Why |
|---|---|
| Root `package.json` | Uses caret ranges, which conflicts with the exact-pin policy in `frontend/` |
| `frontend/ui-design-temp.md`, `frontend/fix.md`, `frontend/tailwind-shadcn-versions.md` | Scratch notes. The TypeScript errors in `fix.md` do not reproduce with TS 7.0.2. |
| `scripts/.dev-rough.sh` | Draft script |
| `docs/api/openapi.m13.yaml` | M13 design draft, superseded by `openapi.yaml` 1.7.0 |
| `.codex/config.toml` | Tool config for another assistant; references Windows `shadcn.cmd` |
| `.cache/milestone*`, `.cache/playwright/winldd-*` | Old Windows-era logs and binaries in the ignored cache |
