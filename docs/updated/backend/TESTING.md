# Backend testing

## Gates

| Command | Proves |
|---|---|
| `bash scripts/dev.sh check` | gofmt, `sqlc vet`, generated code unchanged, goose migrations valid, `go vet`, `go test ./...`, `govulncheck` (no reachable vulnerability) |
| `bash scripts/dev.sh test --race` | Unit tests with the race detector |
| `bash scripts/dev.sh integration --race` | Every `-tags=integration` test against real PostgreSQL |

Integration tests create their own `ecom_foundation_<random>` databases, run migrations up (and down/up where relevant), and drop the database when they finish. They never touch the development database. Missing configuration fails the run instead of skipping tests. A failed cleanup can leave a test database behind for inspection; remove it by exact name only.

Rules:

- Transaction and concurrency guarantees are tested against PostgreSQL, never mocks.
- Concurrency tests must pass repeatedly, not just once.
- Only report results from commands that actually ran.

## Integration test files

`backend/internal/platform/integration/`

| Area | Files |
|---|---|
| Foundation, grants, readiness, migrations | `foundation_test.go` |
| Auth and account security | `auth_test.go`, `account_security_test.go`, `email_verification_test.go`, `email_change_test.go`, `password_reset_test.go` |
| Catalog, admin, cart | `commerce_test.go`, `catalog_read_test.go`, `admin_search_test.go` |
| Checkout and settlement | `checkout_test.go`, `checkout_fault_test.go`, `settlement_test.go`, `settlement_fault_test.go`, `order_http_test.go` |
| Recovery | `recovery_test.go`, `recovery_apply_test.go`, `recovery_command_test.go`, `recovery_fault_test.go` |
| Guest | `guest_test.go`, `guest_checkout_test.go`, `guest_mail_test.go` |
| Fixtures | `fixtures_test.go` |
| Telemetry | `telemetry_test.go`: query spans under a request span, no arguments exported, pool size from the URL, every business counter through real account and guest checkouts, and one trace per account and guest checkout (with the receipt's `smtp send` span) recording no personal data |
| Real SMTP (opt-in) | `smtp_smoke_test.go`. See [OPERATIONS.md](OPERATIONS.md#email-smtp). |
| Database TLS (opt-in) | `database_tls_test.go`. Skipped unless `ECOM_DB_TLS=1`; run it with `bash scripts/dev.sh database-tls-check` against `database-tls`. It checks `verify-full` by host name and IP, the API pool, a wrong host name, an untrusted CA, system roots only, and that `sslmode=disable` still connects. |

## Key experiments

| Experiment | Assertion |
|---|---|
| Last-item contention | 100 concurrent checkouts for 1 unit produce exactly one reservation and no negative stock. |
| Retry after the cart is cleared | The same key and body returns 200 with the same order; a changed address or scenario returns 409. |
| Two keys, one cart version | One order; the other request gets `stale_cart`. |
| T1 rollback | A stock failure on the second item leaves no rows and no stock change. |
| Crash before claim, after claim, and before T2 | The order stays pending and recoverable. Recovery settles it once; a second run changes nothing. |
| Lost COMMIT reply (T1, claim, T2, cancel) | Real PostgreSQL packet faults: at most one order, and 201/202/503 or 200/503 as specified. No double settlement. |
| Recovery concurrency | Two operators running apply settle each order exactly once. Dry-run changes nothing. Corrupt state exits nonzero. |
| Process kill | A separate test process is killed after T1, after the recovery claim, and during T2. The next run recovers safely. |
| Cancellation vs claim | Exactly one wins under the order lock. |
| History | Retiring a product, editing an address or deactivating the user leaves order snapshots unchanged. |
| Auth | JWT claim validation, one winner for concurrent refresh, immediate revocation, role changes, Argon2 limits. |
| Security flows | Token single use and expiry, persisted issuance limits, lost COMMIT, concurrent credential changes. |
| Guest | Ownership, cookie expiry and rotation, cart choice races, intent fencing, mixed account and guest recovery, single-target mailbox access. |

Faults are injected through test-only hooks and proxies. The production API has no fault flags or debug routes.

## Telemetry tests

Unit tests use in-memory span exporters and manual metric readers; nothing needs a Collector.

| Package | Covers |
|---|---|
| `platform/telemetry` | Off by default (no listener, no connection, no log line), settings validation, OTLP/HTTP export to a test server, an unreachable endpoint never delaying requests, rate-limited export errors, the `METRICS_ADDR` listener, trace IDs in logs, and `TestContractListsEveryMetric`, which fails when [OBSERVABILITY_CONTRACT.md](OBSERVABILITY_CONTRACT.md) misses, keeps or misnames a metric |
| `platform/httpserver` | Span names and attributes, continued `traceparent`, bounded `http.route` values (unknown paths, SPA routes and odd methods add no series), errors, 499, unchanged logs with telemetry off, no URL, query or `Authorization` text recorded |
| `platform/database` | Operation names, error codes without messages, pool size from the URL, acquire metrics |
| `platform/metrics`, `auth`, `checkout`, `platform/email` | Each business counter incremented, limiter names, `smtp send` spans without addresses, subjects or bodies |

The export check with a real Collector is manual; see [OPERATIONS.md](OPERATIONS.md#telemetry-export-check).

## Evidence

Dated results are kept in the original evidence files. They are not copied here.

| File | Milestone |
|---|---|
| [MILESTONE_1_FOUNDATION.md](../../backend/evidence/MILESTONE_1_FOUNDATION.md), [AUTHENTICATION](../../backend/evidence/MILESTONE_1_AUTHENTICATION.md), [COMMERCE](../../backend/evidence/MILESTONE_1_COMMERCE.md) | 1 |
| [MILESTONE_2_CHECKOUT.md](../../backend/evidence/MILESTONE_2_CHECKOUT.md) | 2 |
| [MILESTONE_3_PAYMENTS.md](../../backend/evidence/MILESTONE_3_PAYMENTS.md) | 3 |
| [MILESTONE_4_RECOVERY.md](../../backend/evidence/MILESTONE_4_RECOVERY.md) | 4 |
| [MILESTONE_5_BACKEND_VERIFICATION.md](../../backend/evidence/MILESTONE_5_BACKEND_VERIFICATION.md) | Consolidated: 36 backend requirements mapped to tests |

Later milestone results (M6–M13) are recorded in [docs/frontend/TEST_PLAN.md](../../frontend/TEST_PLAN.md). M14 and later results, and the latest Ubuntu results, are in [../STATUS.md](../STATUS.md#verification-on-ubuntu).

## Evidence rules

Record tool versions, the PostgreSQL image digest, the commands, pass or fail, and any limits. Separate targets from observed results. Never invent throughput or error-rate numbers.
