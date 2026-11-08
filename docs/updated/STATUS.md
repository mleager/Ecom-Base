# Project status

**As of 2026-11-07.** Milestones 1–13 are complete. Milestone 14 (production serving and HTTPS) is in progress, followed by Milestone 15 (observability), Milestone 16 (final release) and Milestone 17 (CDN frontend and load-balanced API). Task list: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md).

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
| 14 | Production serving and HTTPS | API serves the SPA from one HTTPS origin; database TLS; production-mode smoke | **In progress** (9/10 tasks: decisions, local certificates, TLS listener, SPA serving, same-origin API base, database TLS, local HTTPS run mode, HTTPS browser group, production-mode smoke). See [MILESTONE_14.md](MILESTONE_14.md) |
| 15 | Observability | OpenTelemetry traces and metrics, logs linked to traces, local stack with dashboards and alerts | **Planned**. See [MILESTONE_15.md](MILESTONE_15.md) |
| 16 | Final baseline release | Application image, Compose deployment, release evidence, tag | **Not started**. See [MILESTONE_16.md](MILESTONE_16.md) |
| 17 | CDN frontend and load-balanced API | SPA on S3 + CloudFront, API tasks behind an ALB, trusted client IP, shared rate limits | **Planned**. See [MILESTONE_17.md](MILESTONE_17.md) |

## Current facts

| Item | Value |
|---|---|
| Schema / readiness version | 13 (migrations `00001`–`00013`), 21 tables plus goose metadata |
| OpenAPI | 1.7.0: 61 business operations (23 guest) + 3 operational routes (`/health/live`, `/health/ready`, `/metrics`) |
| Fixture data | Version 1: 36 products (34 active, 2 retired), 3 accounts |
| Frontend routes | 27 browser routes, including 4 guest routes |
| Browser tests | 348 Chromium tests across 46 spec files |
| Frontend unit/component tests | 1,371 across 47 suites |

## Environment (Ubuntu)

The project moved from Windows to Ubuntu. Current toolchain:

| Tool | Installed | Project pin | Notes |
|---|---|---|---|
| Go | 1.27.3 | `go 1.25.1` in `go.mod` | Works. `GOTOOLCHAIN=local` uses the installed newer Go; no download occurs. |
| goose | 3.28.0 | 3.27.1 | Installed CLI; migrations validate and apply. |
| sqlc | 1.31.1 | 1.31.1 | Matches. |
| Node / npm | 24.20.0 / 11.19.0 | Exact (`engine-strict`) | Node 24 is the system default. |
| PostgreSQL | `postgres:16-alpine` | Moving tag | Only container in use. |
| Playwright Chromium | Revision 1248 (pinned by Playwright 1.64.1) | — | Linux build in `~/.cache/ms-playwright` (the default path). `.cache/playwright` holds only the Windows build. |

Windows-only helpers moved to `scripts/win64/`. Bash entry points are `scripts/dev.sh`, `scripts/certs.sh`, `scripts/fixture.sh` and `scripts/connect.sh`.

## Verification on Ubuntu

| Gate | Result |
|---|---|
| `bash scripts/dev.sh check` (gofmt, sqlc vet/generate, goose validate, go vet, go test) | Pass |
| `bash scripts/dev.sh integration --race` | Pass (about 5 minutes) |
| `npm run typecheck`, `npm test`, `npm run build` | Pass (1,371 tests, 2026-11-07), apart from one intermittent admin test (see [Known limits](#known-limits)) |
| `npm run test:e2e` | Pass, 348/348 (about 19 minutes, 2026-11-07, after the lost-click fix) |
| `npm run test:e2e:https` | Pass, 10/10 (about 1 minute, 2026-11-07) |

The first Ubuntu e2e runs crashed late in the suite. The cause was an unstable CPU core on the host (logical CPUs 8–9), confirmed by pinning tests away from those cores. It was not a code or test defect. The old WSL clock-sync workaround described in older docs no longer applies.

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

## Known limits

- The whole SMTP exchange has a fixed 2 s budget with no retry ([backend/ACCOUNT_SECURITY.md](backend/ACCOUNT_SECURITY.md)). In the production-mode smoke the first send after startup was reported unconfirmed, and the retry succeeded. The user sees "unconfirmed" and can send again; a slow provider could hit this more often.
- The Vitest case `EditProductPage.test.tsx` › "unknown save outcome stays blocked until a successful explicit read and fresh edit" fails about 1 run in 10 (seen 2026-11-07: the description field still reads `Description` where ` Changed description ` was typed). It is unrelated to the cart and HTTPS work and not yet diagnosed.
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
