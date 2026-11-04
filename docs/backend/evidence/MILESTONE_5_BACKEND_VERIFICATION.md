# Milestone 5 — Consolidated backend verification

**Executed:** 2026-10-20 (America/New_York).  
**Result:** Backend Milestones 1–5 are complete. The current backend baseline passes the checks below and is ready for Milestone 6 design/API alignment. Project 1 remains incomplete until frontend acceptance and the final packaged release pass.

This report connects all 36 requirements in the [test plan](../TEST_PLAN.md#requirement-traceability) to executed tests. Earlier reports remain dated evidence of their original increments; this is a fresh verification of the combined backend, not a replacement for those records. No application code, schema, API contract, dependency or container tooling changed during this closeout.

## Tested environment

| Item | Observed value |
|---|---|
| Host/toolchain | Windows/amd64; Go 1.25.1; CGO enabled; WinLibs GCC 16.1.0 |
| Local database tools | goose v3.27.1; sqlc v1.31.1 |
| Database | PostgreSQL 16.13; schema/readiness version 9; 13 domain tables plus goose metadata |
| Container | Healthy `ecom-postgres`, `postgres:16-alpine`, published on loopback only |
| Resolved and running image | `postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416` |

Docker ran PostgreSQL only. Go, goose, sqlc, builds and tests used installed local binaries. Integration fixtures created randomly named, owned databases, ran migrations with migrator credentials and application operations with runtime credentials, then dropped only those test databases. Clean-schema creation, migration no-op/down/reapply and runtime privilege checks are exercised by the foundation fixture/tests. Development data was not reset; recovery apply and crash faults ran only in disposable databases.

## Executed checks

Run native commands from the repository root after the [operator setup](../OPERATIONS.md). The scripts load the ignored local environment; credentials must not be copied into reports or command output.

| Command/check | Result |
|---|---|
| `./scripts/dev.ps1 check` | Passed gofmt, sqlc vet/generation consistency, goose migration validation, go vet and unit tests. Unit results used the Go cache. |
| `./scripts/dev.ps1 integration -Race` | Passed all eight packages with tests, including unit/HTTP and real PostgreSQL integration tests. Expands to `go test -race -tags=integration -count=1 -v ./...`; these results were uncached. |
| `go mod verify` | All cached module checksums verified; this is not a vulnerability scan. |
| `go build -o bin/ecom-api.exe ./backend/cmd/api` | Passed. |
| `go build -o bin/ecom-reconcile.exe ./backend/cmd/reconcile` | Passed. |
| PowerShell AST; `bash -n scripts/dev.sh`; `bash -n infrastructure/postgres/init.sh` | Passed; Bash was the installed Git Bash on Windows. |
| `docker compose config --quiet`; read-only container/image inspection | Passed; health, loopback binding and exact running image verified without dumping environment values. |
| `./scripts/dev.ps1 status`; `bash scripts/dev.sh status` | Both passed; all nine migrations applied, current version 9. |
| `./scripts/dev.ps1 reconcile -Limit 1` | Development dry-run passed: visited 0, diagnostic count 0, no failures/uncertainty. No development apply was run. |
| Inline Python audit using existing isolated OpenAPI validation libraries | Passed OpenAPI 3.0.3 validation, route/operation equality, frontend mapping/ownership, all 305 local Markdown targets/headings and milestone closeout consistency. |

The integration package reported:

```text
ok  ecom/backend/internal/platform/integration  59.514s
```

The full run contained no failed/skipped tests or race-detector reports. `TestRecoveryProcessHelper` returns without work in the parent suite; the four `TestRecoveryProcessCrash` cases launch it in a separate process and verify the actual kill/recovery boundaries. Other packages without tests are command/generated/database wiring packages, not omitted test suites.

The local raw log is ignored `.cache/milestone5-integration-race.log`, SHA-256 `1792458ca3bf7f3a932964e30ff95172decf1aa4008a7e4f8b0ef53b9e7da5e7`. This report is the durable result summary; the cache is not a required deliverable. Restricted Docker-pipe access and Git Bash startup required approved execution outside the sandbox; the approved checks passed without changing tools or container configuration.

## Requirement-to-test evidence

Every test named below passed in the fresh race run. Integration tests live in [the integration package](../../../backend/internal/platform/integration); unit tests are linked where relevant. Grouped IDs share evidence but retain their individual test-plan requirements.

| Requirements | Executed tests and observed guarantee |
|---|---|
| DB-01, DB-02, INIT-01 | `TestFoundation`: canonical/unique email, rejected invalid inventory updates, table count, migration up/no-op/down/reapply, restricted runtime and readiness changing with the actual schema. `TestAuthentication` also exercises normalized/duplicate signup races. |
| AUTH-01, AUTH-05 | `TestAuthentication`: concurrent refresh has one winner; old verifier rejected, scoped logout, failed rotation rolls back, exact fixed seven-day expiry. |
| AUTH-02, AUTH-06 | [Auth unit tests](../../../backend/internal/auth/token_test.go) `TestAccessTokens` and `TestAuthentication`: strict signature/claims, expired/revoked sessions, inactive users, subject binding and current database role. Revocation/role changes affect subsequent authorization checks; already authorized work is not retroactively cancelled. |
| AUTH-03 | [Auth HTTP tests](../../../backend/internal/auth/http_test.go) `TestCSRFAndCORS`, `TestLimiterConcurrencyCapacityAndExpiry`, `TestCookieAttributesAndPeerAddress`, plus `TestAuthentication` rate-limit cases and `TestCommerce` origin policy. Origin/header/cookie/no-store controls and bounded concurrent auth work pass. |
| AUTH-04 | `TestAuthentication`: duplicate signup race and injected cart-insert failure preserve atomic user/cart creation. |
| SEC-01, SEC-02 | `TestAuthentication`, `TestCommerce`, `TestOrderHTTP`, and auth `TestRoleGuard`: current-role enforcement, rejected role input, runtime grant restrictions, foreign address/cart/order denial and admin-only stock/product/metrics access. |
| ACCOUNT-01 | `TestCommerce`: disjoint profile updates, omitted versus null/empty fields, address ownership and optional-field clearing. |
| CATALOG-01, STOCK-01 | `TestCommerce`: SKU conflicts, injected inventory-insert rollback, retirement/reactivation, active-only pagination, concurrent stock adjustments and refusal to reduce stock below reservations. |
| CART-01, CART-04 | `TestCommerce`: add/replace/remove/clear, 30 simultaneous additions, one version increment per successful mutation, coherent reads, lock cancellation and foreign/missing item denial. |
| CART-03 | `TestCommerce`: injected version-write failure leaves no partial cart changes; distinct-product capacity, quantity limits and version exhaustion pass. |
| CART-02 | `TestCheckout` checkout-versus-cart-edit and opposite insertion-order cases: serialized cart snapshot/consumption and ordered inventory locking. |
| ORD-01 | `TestCheckout`: nonempty checkout validation, immutable purchase/address snapshots after source edits/deletion and denied runtime snapshot rewrites. `TestSettlementIntegrity` refuses inconsistent order graphs. The complete graph is an application transaction invariant; foreign keys alone do not prove every order has an item. |
| INV-01 | `TestCheckout/last_unit_100_customers`, `TestOrderHTTPContention`: each experiment admits one winner among 100 customers; HTTP observes one confirmed order and 99 conflicts. |
| INV-02 | `TestSettlement`, `TestRecoveryApply`, `TestRecoveryConcurrency`, `TestRecoveryDiagnostics`: reservation/aggregate checks hold across accept/reject/cancel/recovery; deliberately corrupted aggregates are detected, not silently repaired. |
| PAY-01, PAY-02, PAY-03 | [Simulator unit test](../../../backend/internal/checkout/processing_test.go) `TestLocalSimulator`, `TestSettlement`, `TestRecoveryProcessCrash`: deterministic stored-attempt decisions, concurrent/terminal replay and restart preserve exactly-once consumption/release and history. |
| ID-01, ID-02, ID-03 | `TestCheckout`: sequential/concurrent same-key replay, customer-scoped keys, changed intent conflict and different-key/same-cart-version contention. `TestOrderHTTP` confirms retained retries read status without another simulation. |
| TX-01 | `TestCheckout`: partial reservation failure and late idempotency/cart-version failures roll back the entire T1 graph, counters and cart consumption. `TestCheckoutRetries` checks bounded retry policy. |
| TX-02, REC-01, REC-02 | `TestRecoveryApply`, `TestRecoveryCommand`, `TestRecoveryProcessCrash`: pending/processing accept/reject recovery, expiry without forced release, rerun safety and actual kills after T1, after claim, during T2 and after T2 commit. |
| TX-03 | `TestSettlementRollback`, `TestRecoveryRollback`: failures partway through settlement/cancellation leave no partial inventory/reservation/payment/order/history update. |
| TX-04 | `TestCheckoutCommitUncertainty`, `TestOrderHTTPCommitUncertainty`, `TestRecoveryCommitUncertainty`: real PostgreSQL socket faults before/after COMMIT and unfinished upstream transactions distinguish known outcomes from explicit uncertainty without duplicate orders or settlement. |
| REC-03 | `TestRecoveryDiscovery`, `TestRecoveryDiagnostics`, `TestRecoveryConcurrency`, `TestRecoveryCommand`: unchanged persisted snapshots for dry-run, consistent concurrent diagnostics, bounded examples/exact totals, SKIP LOCKED ownership and safe overlapping apply runs. |
| NUM-01 | [Checkout unit tests](../../../backend/internal/checkout/intent_test.go) `TestMoneyBoundsAndIdentities`, `TestCheckout`, `TestCommerce`, [commerce validation tests](../../../backend/internal/commerce/validation_test.go): checked quantity/price/total/delta/version boundaries and multiplication/subtotal overflow. |
| API-01 | `TestOrderHTTP`, `TestOrderHTTPCommitUncertainty`, `TestCommerce`, `TestAuthentication`, [server tests](../../../backend/internal/platform/httpserver/server_test.go) and [strict JSON tests](../../../backend/internal/platform/httpjson/json_test.go), plus OpenAPI validation/route audit: typed responses, strict requests, ownership/status codes, operational routes and 201/200/202/503 checkout outcomes. This combines contract-focused tests and inventory checks; it is not exhaustive generated schema validation of every response. |

Concurrency repeat evidence is preserved in [commerce](MILESTONE_1_COMMERCE.md), [T1](MILESTONE_2_CHECKOUT.md), [payment](MILESTONE_3_PAYMENTS.md) and [recovery](MILESTONE_4_RECOVERY.md): each relevant suite previously passed three additional repetitions. This closeout adds one fresh full race run; it does not re-date those repeated runs or claim throughput/latency/load-test targets.

## Readiness and remaining work

The [architecture](../OVERVIEW.md), [physical schema](../DATABASE_SCHEMA.md), [checkout/state design](../CHECKOUT_DESIGN.md), [decisions](../IMPLEMENTATION_DECISIONS.md), [operations](../OPERATIONS.md) and [recovery runbook](../RECOVERY.md) describe the implemented baseline. The route audit accounts for all 29 mounted OpenAPI operations: 26 business operations mapped to frontend screens/actions/tests and three operational exceptions. All 26 frontend acceptance IDs and six gap IDs retain implementation owners in the [API integration audit](../../frontend/API_INTEGRATION.md).

No failing backend gate remains from the executed checks. The following limits and future gates remain explicit:

- **Milestone 6:** verify/pin frontend tooling, design routes/components/fixtures and implement the already selected public search and three admin-read extensions with contract/tests. These endpoints/query support are future work, absent from today's OpenAPI. Bounded cart presentation and auth coordination retain their assigned owners.
- **Milestones 7–11:** implement the Vite/React/TypeScript application and prove customer/admin acceptance through component/build/browser tests. No frontend, passing browser journeys or completed acceptance criteria are claimed here.
- **Milestone 12:** verify the packaged complete application, migrations/health/recovery and immutable healthy release for Projects 2–6; final container build/tag/source identity is pending. This report is not a tagged release or production deployment approval.
- **Verification limits:** native Linux/macOS execution, rendered diagrams, manual SQL-client provisioning interaction and production deployment remain unverified. Windows source/command tests cover the documented provisioning policy; arbitrary external SQL clients are not supplied. Argon2 benchmarks and the earlier first-init/overwrite test are retained historical evidence, not fresh benchmark/setup claims. No vulnerability scan or CI run was performed.

Future API changes must preserve the current transactional/security guarantees and rerun affected checks. Backend readiness closes Milestone 5; the [project status](../../PROJECT_STATUS.md) continues to own full-application completion.
