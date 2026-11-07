# Frontend testing

All commands run from `frontend/`.

## Commands

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over app, test and config sources |
| `npm test` / `npm run test:watch` | Vitest (jsdom for components, Node for controllers and contracts): 1,368 tests in 46 suites |
| `npm run build` | Type check, then production build |
| `npm run test:e2e` | All 348 Playwright tests against real Go and PostgreSQL |
| `npm run test:e2e:list` | Discovery only; builds nothing |
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

Append `-- --grep "title"` to narrow a run, or `-- --list` to list tests. A unit test checks that every spec file belongs to exactly one group.

## Browser setup

```bash
export PLAYWRIGHT_BROWSERS_PATH="$(cd .. && pwd)/.cache/playwright"
npm exec -- playwright install chromium --only-shell
```

If you set `PLAYWRIGHT_BROWSERS_PATH`, keep it set for every `test:e2e` run. Without it, Playwright uses `~/.cache/ms-playwright`, which is where this machine's Linux Chromium is installed. The repository's `.cache/playwright` holds only the old Windows build, so pointing there without installing first makes every test fail at browser launch.

Requirements: PostgreSQL running, root `.env` present, Go and goose installed, ports **5173** and **18080** free.

## How the harness works

- Playwright starts its own Vite server on 5173 (strict port, no reuse) with `VITE_API_BASE_URL` overridden to `http://localhost:18080/api/v1`. Environment files are not changed.
- Each worker builds three native binaries once into `.cache/frontend-e2e/<id>/`: the fixture CLI, the API, and an integration-only control binary.
- **Each test** gets a fresh fixture database, fresh accounts and JWT secret, its own API process on 127.0.0.1:18080, a fresh mailbox and limiter state, and a fresh browser context. It cleans all of these up even when the test fails.
- **One worker, zero retries.** The fixed API port makes parallel workers impossible; the config rejects them.
- Traces, screenshots and video are off. `SafeReporter` prints only test names, locations, HTTP status numbers, cleanup IDs and timings. It never prints raw errors, DOM, request values or console output, so runs with real credentials stay private.
- Email tests use an isolated TLS SMTP peer, not external mail.
- Test-only controls (expire a session, deactivate or demote a user, push a cart near its version limit) exist only in the integration binary and are restricted to named fixture accounts.

Restart the run after changing source files. If a run is interrupted, use `fixture-remove` for any leftover fixtures. See [FIXTURES.md](FIXTURES.md).

## When to run what

| Situation | Required |
|---|---|
| While coding | Targeted Vitest files; new and related browser cases |
| Finishing a feature | Full `npm test`, `npm run build`, affected browser groups |
| Changing shared auth, routing, API, coordination, styles, schema, fixtures or harness | **Full** browser suite |
| Milestone or release | Full frontend, browser and backend integration suites |
| Isolated failure | Re-run that case or `test:e2e:failed`, and record both results. A focused pass never replaces a required full run. |
| Docs-only change | Unit and build checks. Do not claim a new browser run. |

Never use retries or longer timeouts to hide a failure. Never reuse databases, cookies or browser storage between tests.

## Environment notes

- A full run takes about 19 minutes on the Ubuntu host.
- Random crashes late in the run were traced to a hardware fault (unstable CPU cores 8–9). If crashes appear without a clear test failure, check host stability before debugging tests.
- Only Chromium is covered.

Dated acceptance evidence for M7–M13 is in the original [TEST_PLAN.md](../../frontend/TEST_PLAN.md).
