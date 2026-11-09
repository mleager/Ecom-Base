# Frontend testing

All commands run from `frontend/`.

## Commands

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over app, test and config sources |
| `npm test` / `npm run test:watch` | Vitest (jsdom for components, Node for controllers and contracts): 1,373 tests in 47 suites |
| `npm run build` | Type check, then production build |
| `npm run test:e2e` | All 348 Playwright tests against real Go and PostgreSQL |
| `npm run test:e2e:list` | Discovery only; builds nothing |
| `npm run test:e2e:https` | The HTTPS browser group: 10 tests against the API serving the built SPA over TLS (see below) |
| `npm run test:e2e:failed` | Re-run the failures from the last invocation |
| `npm run design:check` | Design-preview checks (separate from the real suite) |

### Browser groups

| Group | Coverage |
|---|---|
| `test:e2e:auth` | Auth, sessions, account security, email, recovery |
| `test:e2e:storefront` | Catalog, cart, account, guest, cross-application journeys |
| `test:e2e:checkout` | Checkout, recovery, orders, observation |
| `test:e2e:admin` | Every admin operation and role check |
| `test:e2e:harness` | Binary reuse and state isolation |
| `test:e2e:smoke` | Public shell with mocks; no database needed |

Append `-- --grep "title"` to narrow a run, or `-- --list` to list tests. A unit test checks that every spec file belongs to exactly one group, and that the HTTPS group stays outside `npm run test:e2e`.

## Browser setup

```bash
export PLAYWRIGHT_BROWSERS_PATH="$(cd .. && pwd)/.cache/playwright"
npm exec -- playwright install chromium --only-shell
```

If you set `PLAYWRIGHT_BROWSERS_PATH`, keep it set for every `test:e2e` run. Without it, Playwright uses `~/.cache/ms-playwright`, which is where this machine's Linux Chromium is installed. The repository's `.cache/playwright` holds only the old Windows build, so pointing there without installing first makes every test fail at browser launch.

Requirements: PostgreSQL running, root `.env` present, Go and goose installed, and for each worker *n* ports **5173+n** and **18080+n** free (5173–5176 and 18080–18083 with the default four workers).

## How the harness works

- **Four workers by default.** `E2E_WORKERS` (or `--workers`) sets 1–16. Each worker *n* (Playwright's parallel index) starts its own Vite server on 5173+n (strict port, no reuse) with `VITE_API_BASE_URL` set to `http://localhost:18080+n/api/v1`, so workers share nothing but PostgreSQL. Environment files are not changed.
- Each worker builds three native binaries once into `.cache/frontend-e2e/<id>/`: the fixture CLI, the API, and an integration-only control binary.
- **Each test** gets a fresh fixture database, fresh accounts and JWT secret, its own API process on 127.0.0.1:18080+n, a fresh mailbox and limiter state, and a fresh browser context. The API is stopped at the end of the test, even when it fails. The fixture database is removed on a per-worker queue that overlaps the next test; the worker waits for the queue before it exits.
- Fixture databases are cloned from a migrated template, so goose runs once per migration set, not per test ([FIXTURES.md](FIXTURES.md#migration-template)).
- Test APIs never inherit `METRICS_ADDR`, `OTEL_*`, `TLS_*` or `STATIC_DIR` from your shell, so telemetry stays off in every browser test.
- **Zero retries.**
- Traces, screenshots and video are off. `SafeReporter` prints only test names, locations, HTTP status numbers, cleanup IDs and timings. It never prints raw errors, DOM, request values or console output, so runs with real credentials stay private.
- Email tests use an isolated TLS SMTP peer, not external mail.
- Test-only controls (expire a session, deactivate or demote a user, push a cart near its version limit) exist only in the integration binary and are restricted to named fixture accounts.

## HTTPS browser group

`npm run test:e2e:https` runs `tests/e2e-https/` with its own config, `playwright.https.config.ts`. It is separate from `npm run test:e2e`, which stays the HTTP suite.

- **Setup:**
  - There is no Vite server.
  - Once per run, the harness builds the same-origin SPA (`vite build --mode same-origin`) into `.cache/frontend-e2e-https/dist`. Your own `frontend/dist`, which `serve-https` uses, is left alone.
  - Each test then starts its own fixture API like `serve-https`: on `https://localhost:18443`, with TLS from `.cache/certs/`, `STATIC_DIR` pointing at that build, and Secure cookies. The mail-enabled API variant runs the same way.
- **Certificates:**
  - Run `bash scripts/certs.sh` first.
  - Only this project sets `ignoreHTTPSErrors`, because headless Chromium does not read the desktop trust store.
  - The harness readiness probe does verify the server certificate against `ca.pem` and the `localhost` name.
- **Coverage:**
  - deep links and reloads for public, customer and admin route families
  - `__Secure-` cookie names with `Secure`, `HttpOnly` and `SameSite=Strict`
  - session restore after a reload
  - a leftover plain-HTTP cookie not blocking the guest cart
  - guest checkout, accepted and rejected
  - the cart choice followed by an account checkout
  - order detail and cancellation
  - email-link pages with a `#token` fragment
  - JSON 404s for unknown API paths
  - cache and security headers on `index.html`, hashed assets and fixture images
- **Requirements:** the same as the HTTP suite, plus the certificates and port **18443** free. It runs one worker and takes about one minute.

Restart the run after changing source files. If a run is interrupted, use `fixture-remove` for any leftover fixtures. See [FIXTURES.md](FIXTURES.md).

## When to run what

| Situation | Required |
|---|---|
| While coding | Targeted Vitest files; new and related browser cases |
| Finishing a feature | Full `npm test`, `npm run build`, affected browser groups |
| Changing shared auth, routing, API, coordination, styles, schema, fixtures or harness | **Full** browser suite |
| Changing static serving, TLS, cookies or the same-origin build | Full browser suite and `npm run test:e2e:https` |
| Milestone or release | Full frontend, browser (`test:e2e` and `test:e2e:https`) and backend integration suites |
| Isolated failure | Re-run that case or `test:e2e:failed`, and record both results. A focused pass never replaces a required full run. |
| Docs-only change | Unit and build checks. Do not claim a new browser run. |

Never use retries or longer timeouts to hide a failure. Never reuse databases, cookies or browser storage between tests.

## Environment notes

- A full run takes about 5 minutes on the Ubuntu host with four workers (about 18 minutes with one).
- Random crashes late in the run were traced to a hardware fault (unstable CPU cores 8–9). Run the suites pinned with `taskset -c 0-7,10-31`, and never run the browser and Go integration suites at the same time. If crashes appear without a clear test failure, check host stability before debugging tests.
- Only Chromium is covered.

Dated acceptance evidence for M7–M13 is in the original [TEST_PLAN.md](../../frontend/TEST_PLAN.md).
