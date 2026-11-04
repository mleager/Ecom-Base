# Backend Project Status

**Updated:** 2026-11-02 (America/New_York; M13 guest-cart/search foundation).  
**Current position:** Backend Milestones 1–5 are complete. Milestone 6's additional search/admin-read verification is recorded below; frontend design/fixture progress is tracked separately. Historical test results below retain their execution dates. Frontend and release rollups are in [project status](../PROJECT_STATUS.md); the full application is not complete.

Milestone scope is defined in [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md), API behavior in [OpenAPI](../api/openapi.yaml), and engineering choices in [IMPLEMENTATION_DECISIONS.md](IMPLEMENTATION_DECISIONS.md).

M13 Task 5 adds migration **13** and API **1.7.0** with **61 business operations and three operational checks**. Account and guest orders share checkout and reconciliation. Guest recovery uses an exact-target mailbox proof and scoped cookie. Native checks, isolated TLS tests and the configured SMTP round trip passed. The mailbox owner confirmed receipt. [Task 5 evidence](../frontend/TEST_PLAN.md#milestone-13--guest-checkout-and-scoped-recovery)

Post-baseline extension (M9 tasks 3–6, 2026-10-27): password changes, standard-library TLS SMTP, explicit email verification, verified email changes and forgotten-password recovery are implemented. Public recovery uses non-disclosing requests, 15-minute single-use verified-email proofs and atomic password/token/session changes. Confirmed browser resets recheck session state and preserve unrelated accounts. Readiness/schema stays **11**, with **15** domain tables; recovery adds no migration/dependency. OpenAPI **1.5.0** has **38** business operations plus three operational checks. [Security/recovery acceptance and limits](../frontend/TEST_PLAN.md#milestone-9-password-recovery-progress) owns current verification; historical milestone evidence below retains its original versions/dates.

**Development layout:** Root `compose.yaml` and `.env` support ordinary `docker compose` commands from the repository root. The bootstrap script stays at `infrastructure/postgres/init.sh`; the development scripts select the new Compose path. The project/volume identities remain `ecom`/`ecom_postgres_data`, preserving the existing database. Earlier evidence records the paths used when those checks ran.

Layout verification (2026-10-19): root and explicit subdirectory Compose configuration checks passed; the full resolved configuration matches its pre-move hash exactly. The bootstrap mount source exists, all development scripts pass syntax checks, and native `go test ./...` passes through `./scripts/dev.ps1 test`.

## Milestone 1 — Complete

- [x] Root Go 1.25.1 module, local Go/goose/sqlc workflow, PostgreSQL-only Compose using `postgres:16-alpine`.
- [x] All 13 approved tables, indexes and constraints; explicit migrations and restricted runtime credentials.
- [x] Validated configuration, connection/request bounds, health/readiness, safe structured logs and graceful shutdown.
- [x] Customer registration with atomic cart creation, Argon2id passwords, JWT access, rotating refresh sessions, logout and current-role authorization.
- [x] Account profile reads/partial updates and owned saved-address create/list/update/delete with US address validation.
- [x] Public active-product browsing/pagination; administrator product creation, partial updates, retirement/reactivation and stock adjustments.
- [x] Atomic product/inventory creation and reservation-aware stock bounds.
- [x] Persistent cart read/add/replace/remove/clear; parent-row serialization, coherent reads, one version increment per successful mutation and bounded quantities/capacity/versions.
- [x] Unit/HTTP/PostgreSQL integration tests, race checks, repeated concurrency tests, rollback injection, migration down/reapply in disposable databases and sqlc generation checks.

Milestone 1 completed at migration **7**, with column-scoped feature permissions and no new domain tables. Milestone 2 advanced to version **8** and Milestone 3 advances the development database/API readiness requirement to **9**. Restart an older API process after updating. No application/tooling containers or new runtime dependencies were introduced.

Verified commands:

- `./scripts/dev.ps1 check` — passed formatting, sqlc vet/generation consistency, goose validation, go vet and native unit tests.
- `./scripts/dev.ps1 integration -Race` — passed against PostgreSQL 16.13/schema 7, including the existing foundation/authentication tests.
- `go test -race -tags=integration -run '^TestCommerce$' -count=3 ./backend/internal/platform/integration` — passed three repetitions with fresh disposable databases.
- `go build -o bin/ecom-api.exe ./backend/cmd/api` — passed.
- `./scripts/dev.ps1 migrate` — applied migration 7 successfully to the development database.
- OpenAPI 3.0.3 document validation — passed with the isolated local validator; concrete response-schema examples also passed.

Evidence: [foundation](evidence/MILESTONE_1_FOUNDATION.md), [authentication](evidence/MILESTONE_1_AUTHENTICATION.md), and [completed account/catalog/cart increment](evidence/MILESTONE_1_COMMERCE.md). The earlier increment reports describe their state at the time; this status and the latest evidence record current completion.

## Milestone 2 — Complete

This section records Milestone 2's completion state; Milestone 3 below enables the HTTP routes and adds settlement permissions.

- [x] Request/key validation, canonical intent hashing, advisory-lock encoding, checked money arithmetic and stable retry identities; native unit/static/generation checks pass.
- [x] Complete T1 service and sqlc query implementation; checkout HTTP remains disabled.
- [x] Real PostgreSQL verification of atomic creation, snapshots, idempotency, competing requests, rollback and uncertain COMMIT handling.
- [x] Full race suite and three additional repetitions of every checkout test; migration 8 applied to the development database and final evidence recorded.

The five implementation steps form one service operation: `checkout.Service.CreatePending`. It validates the authenticated actor and request, resolves retained idempotency intent, locks the cart, snapshots shipping/items/prices, checks totals, reserves stock in UUID order, creates the complete pending-order graph, consumes the cart and commits atomically. Identical retries return the retained order/current status without simulation, including after source data changes or deletion. Known PostgreSQL aborts have bounded retries; lost COMMIT acknowledgement uses an independent healthy pooled connection and the same advisory lock before returning a known order or `checkout_outcome_uncertain`.

Migration **8** adds T1 insertion permissions and reserved-counter writes, without adding domain tables. Existing role/ownership restrictions remain; order snapshots, idempotency/history records and payment/reservation transitions cannot be rewritten through runtime SQL at this milestone. Checkout is implemented and tested through the service layer only. Checkout/order HTTP routes remain disabled until Milestone 3; no payment is processed yet.

Verified commands:

- `./scripts/dev.ps1 check` — passed formatting, sqlc vet/generation consistency, goose validation, go vet and unit tests.
- `./scripts/dev.ps1 integration -Race` — passed all packages on PostgreSQL 16.13/schema 8, including earlier milestone tests.
- `go test -race -tags=integration -run '^TestCheckout' -count=3 ./backend/internal/platform/integration` — passed three additional repetitions of all T1, retry and commit-uncertainty tests.
- `go build -o bin/ecom-api.exe ./backend/cmd/api` — passed.
- `./scripts/dev.ps1 migrate` — applied migration 8 successfully to the development database.

Evidence: [Milestone 2 checkout verification](evidence/MILESTONE_2_CHECKOUT.md). Each contention experiment used 100 customers and observed one winner; connection-loss tests exercised real PostgreSQL sockets before/after COMMIT and while the upstream transaction remained unfinished. These tests do not claim payment settlement or recovery verification.

## Milestone 3 — Complete

- [x] Claim, deterministic simulator, guarded settlement/cancellation services, read APIs and HTTP wiring implemented; native unit/static/generation checks pass.
- [x] PostgreSQL concurrency, settlement rollback, HTTP contract and commit-loss verification.
- [x] Full race suite, three additional repetitions of all new integration tests, development migration 9 and final evidence.

Checkout HTTP now performs T1, commits a processing claim, invokes the local deterministic simulator outside a transaction, and runs atomic T2. Acceptance consumes stock once; rejection releases holds once and preserves a failed order. Owner-only cancellation can win only before the claim. Every terminal retry validates state and avoids another stock/history update. Matching checkout retries and GET routes only read status.

Enabled routes: `POST /api/v1/checkout`, `GET /api/v1/orders`, `GET /api/v1/orders/{id}`, `GET /api/v1/orders/{id}/payments`, and `POST /api/v1/orders/{id}/cancel`. Existing active-session authentication, CORS, body bounds, no-store responses and safe logging apply. Pagination is bounded and deterministic; foreign order IDs return 404.

Migration **9** adds column-scoped status/timestamp/failure-code writes for orders, attempts and reservations. The 13 tables, immutable snapshots/intent/attempt identity, local toolchain and PostgreSQL-only Compose remain. New terminal orders return 201; retained retries return 200; a known committed pending order after interruption returns 202. Unresolved checkout/cancellation COMMIT returns 503 rather than guessing its outcome.

Verified commands:

- `./scripts/dev.ps1 check` — passed formatting, sqlc vet/generation consistency, goose validation, go vet and unit tests.
- `./scripts/dev.ps1 integration -Race` — passed all packages on PostgreSQL 16.13/schema 9, including prior milestones, new HTTP/service concurrency, rollback, corruption refusal and real-socket commit-loss tests.
- `go test -race -tags=integration -run '^Test(Settlement|OrderHTTP)' -count=3 ./backend/internal/platform/integration` — passed three additional repetitions of every new integration test.
- `go build -o bin/ecom-api.exe ./backend/cmd/api` — passed.
- `./scripts/dev.ps1 migrate` — applied migration 9 successfully to the development database.
- OpenAPI 3.0.3 validation — passed document/unique-key checks and concrete request/error/order/payment examples using the existing isolated local validator.

Evidence: [Milestone 3 payment verification](evidence/MILESTONE_3_PAYMENTS.md). The HTTP last-unit experiment observed one confirmed order and 99 conflicts among 100 customers. Twenty competing finalizers/cancellations and 30 claim-versus-cancel races preserved exactly-once stock/history. Actual claim/T2/cancellation COMMIT-loss cases verified known versus unresolved responses.

Interrupted pending/processing attempts retain their holds. There is no automatic recovery; crossing 15 minutes does not release inventory. Milestone 4 below provides the explicit operator recovery command.

## Milestone 4 — Complete

- [x] CLI flags and read-only candidate discovery: native checks and real PostgreSQL race tests pass; eligibility, stable order, limits and persisted-state immutability verified.
- [x] Consistent read-only diagnostics: counter/link/quantity/deadline/total/payment corruption detected, findings bounded to 100 with exact totals, and snapshot consistency verified across concurrent settlement.
- [x] Pending-attempt recovery and bounded SKIP LOCKED processing; eligibility, fixed cutoff, visit limits, skipped locks and corruption/cursor behavior pass real PostgreSQL race tests.
- [x] Processing-attempt recovery and uncertain COMMIT handling; acceptance/rejection, inactive customers, concurrent operators, 30-order cancellation races, rollback and retry/COMMIT-loss cases pass.
- [x] Command-level crash/concurrency tests, repeated race suite, operator documentation and final evidence.

`backend/cmd/reconcile` defaults to read-only inspection and supports explicit apply with default 100 visits, range 1–1,000. It captures one database cutoff, skips locked candidates, advances an expiry/UUID cursor, claims pending attempts or re-derives processing attempts, and reuses guarded settlement outside the claim transaction. Inactive customers' existing orders remain recoverable. Expiry never forces release/rejection. No new table, migration, grant, dependency, worker or tooling container was introduced; schema/readiness remain **9**.

Diagnostics run in a consistent read-only snapshot, detect counter/link/total/deadline/payment-state mismatches including terminal inconsistencies, and return at most 100 examples with the exact distinct finding count. Apply validates each graph again under locks; corruption is reported without repair. Safe JSONL events/summary and nonzero failure/uncertainty exits support operator review and reruns. Unknown claim/T2 COMMIT uses a fresh bounded full-graph read; no unknown state is reported as successful or blindly retried.

Verified commands:

- `./scripts/dev.ps1 check` — passed formatting, sqlc vet/generation consistency, goose validation, go vet and native tests.
- `./scripts/dev.ps1 integration -Race` — passed all packages against PostgreSQL 16.13/schema 9, including all earlier milestone tests and recovery service/command/crash tests.
- `go test -race -tags=integration -run '^TestRecovery' -count=3 ./backend/internal/platform/integration` — passed three additional repetitions of every recovery test.
- `go build -o bin/ecom-api.exe ./backend/cmd/api` and `go build -o bin/ecom-reconcile.exe ./backend/cmd/reconcile` — passed.
- PowerShell AST and Git Bash `-n` development-script syntax checks — passed. Native Linux/macOS execution remains unverified.
- `./scripts/dev.ps1 reconcile -Limit 1` — development read-only smoke check passed: zero candidates and zero diagnostic findings; no apply was run against development data.

Real subprocess kills after T1, after claim, during partial T2, and after T2 commit were followed by safe command recovery/replay. Two operators could derive the same processing attempt while stock/history changed once. Thirty orders raced cancellation against two recovery runs. Claim/T2 wire faults exercised rollback, lost acknowledgements and still-unfinished commits; SQL trigger faults verified rollback/retry bounds. Full results and limits are recorded in [Milestone 4 evidence](evidence/MILESTONE_4_RECOVERY.md).

Operator commands and interpretation: [RECOVERY.md](RECOVERY.md). PowerShell: `./scripts/dev.ps1 reconcile -Limit 100` then, when applying intentionally, `./scripts/dev.ps1 reconcile -Apply -Limit 100`.

## Milestone 5 — Complete

Scope, architecture/schema, engineering decisions, the [frontend/API audit](../frontend/API_INTEGRATION.md), [operator guide](OPERATIONS.md) and [recovery instructions](RECOVERY.md) are complete. The [consolidated verification report](evidence/MILESTONE_5_BACKEND_VERIFICATION.md) maps all 36 backend requirement IDs to executed tests and records the environment, results and remaining gates.

Fresh verification (2026-10-20, Windows): native formatting/static/sqlc generation/goose checks, unit tests, module checksum verification and both API/recovery builds passed. The full uncached PostgreSQL integration/race suite passed, including contention, rollback, real COMMIT-loss faults and four actual subprocess-kill boundaries; the integration package completed in **59.514s** on PostgreSQL **16.13**, schema **9**. Historical three-repeat concurrency evidence remains dated in the earlier reports.

PowerShell AST, Git Bash/bootstrap syntax, quiet Compose validation and both local migration-status actions passed. A development recovery dry-run visited zero candidates and found zero inconsistencies; development data was not reset or subjected to apply. Disposable tests verified clean/no-op/down/reapply migrations, restricted runtime credentials and recovery apply/rerun behavior. Earlier operator verification on 2026-10-20 also passed isolated first-init/overwrite protection and secret generation; manual SQL-client interaction remains unverified.

OpenAPI validation and route inventory match all **29** current operations, with **26** business mappings and three operational exceptions. All 26 frontend acceptance criteria and six gap IDs retain owners; local documentation targets/headings and milestone closeout checks pass. No application/schema/API/dependency change or tooling container was introduced in this closeout.

Next: **Milestone 6 — frontend design and API alignment**, including the selected search/admin-read extensions. Browser/component/build acceptance and final release remain outstanding in [project status](../PROJECT_STATUS.md). Native Linux/macOS execution, rendered diagrams, production deployment and fresh performance/security scans are not claimed. Backend readiness completes Milestone 5, not the full application.

## Milestone 6 — Backend API alignment

Verified 2026-10-21: public `GET /products` accepts bounded literal case-insensitive q over active names/SKUs before pagination; three current-admin GETs expose product list/detail and coherent inventory for active/retired products. Existing Product/Inventory/Cart representations and schema/readiness **9** remain. No migration, grant, index extension, runtime dependency or tooling container was added.

`./scripts/dev.ps1 check`, `go vet -tags=integration ./...`, the API build and full `./scripts/dev.ps1 integration -Race` passed (PostgreSQL 16.13; integration package **60.849s**). New search/admin/cart-readiness tests verify strict queries, filtered pagination/Unicode/literal escapes, runtime role/activation checks, read-only timestamps, corrupt graph refusal and coherent counters across 100 updates/100 reads. All earlier checkout/recovery/crash tests pass. An initial sqlc parser crash passed on unchanged rerun; final native gates pass. Raw logs are ignored `.cache/milestone6-api-check.log` and `.cache/milestone6-api-integration-race.log`.

OpenAPI and the [frontend integration inventory](../frontend/API_INTEGRATION.md) now cover **29 business operations plus three operational checks**. Frontend test/harness/fixture ownership is in the [test plan](../frontend/TEST_PLAN.md). Reusable fixtures are completed in the closeout below; actual browser proof and frontend feature acceptance remain their later milestones. Development data was not reset or modified by tests; restart an existing API to use updated routes.

Milestone 6 closeout (2026-10-21): [versioned isolated fixtures](../frontend/FIXTURES.md) now provide fresh database creation/migration/seed, owner/marker-checked inspection/removal, private random credentials and local public SVGs. No schema, API operation, dependency or service was added. Full native race/integration verification passed (**63.079s**), including fixture logins, authorization, fallback/search data, tamper refusal, partial-setup cleanup and preservation of existing data; focused fixture assertions subsequently passed (**4.321s**). Native checks/build/vet and PowerShell/Git Bash script checks/round trip passed. Fixture version **1**, schema **9**; raw log `.cache/milestone6-fixtures-integration-race.log`. Milestone 6 is complete; M7 initializes the frontend, with browser and final release proof still outstanding.
