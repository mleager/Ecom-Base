# Frontend testing

## Strategy

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Browser tests run against the real Go API and PostgreSQL**, not mocks | Cookies, CSRF, idempotency and uncertain outcomes only mean something end to end | A full run takes about 5 minutes and needs Docker |
| **Every test gets its own database, API process, secrets, mailbox and browser context** | No test can leak state into another, so tests can run in parallel and in any order | A fresh backend per test; template databases keep that fast |
| **Zero retries; no longer timeouts to hide failures** | A flaky test is a bug to fix, not to retry | Failures must be investigated |
| **Faults come from test-only controls in a separate integration binary** (expire a session, demote a user, push a cart near its version limit) | The production API has no test hooks | One extra binary to build per worker |
| **Reports never print raw errors, DOM, request values or console output** | Runs with real credentials stay private | Debugging uses an opt-in trace |
| **A separate HTTPS group** runs the built same-origin SPA over TLS | `__Secure-` cookies, cache and security headers, and deep links behave differently over HTTPS | Two browser configurations |

## Suites

| Command (from `frontend/`) | What it proves |
|---|---|
| `npm run typecheck`, `npm run build` | Types and the production build |
| `npm test` | 1,374 Vitest unit and component tests (jsdom for components, Node for controllers and contracts) |
| `npm run test:e2e` | 348 Playwright tests in Chromium against real Go and PostgreSQL, 4 workers |
| `npm run test:e2e:https` | 10 tests against the API serving the built SPA over TLS |
| `bash scripts/dev.sh deploy-verify` | A browser journey against the release image in the Compose deployment |

The browser suite is split into groups (`auth`, `storefront`, `checkout`, `admin`, `harness`, `smoke`). A unit test checks that every spec file belongs to exactly one group.

## How the harness isolates tests

- Each worker *n* runs its own Vite server on port 5173 + *n* and API port 18080 + *n*; workers share only PostgreSQL.
- Each test clones a fresh fixture database from a migrated template ([FIXTURES.md](FIXTURES.md)), and gets new accounts, a new JWT secret, its own API process, a TLS mail peer and limiter state, and a new browser context. The API stops when the test ends, even on failure.
- Test APIs never inherit telemetry, TLS or static-serving settings from the shell.

## When to run what

| Change | Required |
|---|---|
| A feature | `npm test`, `npm run build`, and the affected browser groups |
| Shared auth, routing, API client, coordination, styles, schema, fixtures or harness | The **full** browser suite |
| Static serving, TLS, cookies, or the same-origin build | The full suite and `test:e2e:https` |
| A release | Everything, including backend integration and `deploy-verify` |

The latest counts and tool versions are in [../RELEASE.md](../RELEASE.md).
