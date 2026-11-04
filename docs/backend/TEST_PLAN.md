# Test Plan — Project 1

Task 5 verification covers migration 13, guest preparation and retirement, both payment outcomes, mixed-owner reconciliation, scoped recovery and isolated TLS proof delivery. The mailbox owner confirmed arrival of the controlled test email. [Native evidence](../frontend/TEST_PLAN.md#milestone-13--guest-checkout-and-scoped-recovery) · [Acceptance matrix](GUEST_COMMERCE_DESIGN.md#implementation-gates-and-acceptance-ownership)

**Status:** Implementation baseline v1.0. Tests are required evidence, not claims of existing functionality. Use local `go test` and the race detector, disposable databases on the Compose PostgreSQL instance, HTTP contract tests and Vitest/Playwright for later web flows. No Testcontainers or tooling containers are used under the owner's local-tooling decision.

The accepted defaults and edge-case policies are in `IMPLEMENTATION_DECISIONS.md`. Go 1.25.1 and the resolved `postgres:16-alpine` image must match the tested setup. The root Go module covers `backend/`; run installed Go/goose/sqlc binaries locally from the repository root per the owner's instruction. Docker runs PostgreSQL only. Foundation, account/catalog/cart, T1, settlement/cancellation, checkout/order HTTP and recovery tests use owned disposable databases on that server. Recovery coverage includes command execution, real subprocess kills, concurrent operators, diagnostics, rollback and commit uncertainty. Executed evidence is in `evidence/MILESTONE_2_CHECKOUT.md`, `evidence/MILESTONE_3_PAYMENTS.md`, and `evidence/MILESTONE_4_RECOVERY.md`; this plan alone is not proof of completion.

## Gates

M9 security extensions reuse native PostgreSQL fixtures and the injected TLS SMTP test peer. `password_reset_test.go` adds recovery eligibility/timing parity, persistent three-link limits, atomic consumption/revocation/cancellation, post-lock expiry/version checks, concurrent credential/session/email changes, rollback and lost COMMIT tests. Auth handler tests cover global admission/cancellation and real suppression timing. [Frontend security/recovery evidence](../frontend/TEST_PLAN.md#milestone-9-password-recovery-progress) records browser/controller/privacy coverage and the current full-suite result; historical backend milestone evidence remains unchanged. Routine tests never send external mail.

The [Milestone 5 consolidated report](evidence/MILESTONE_5_BACKEND_VERIFICATION.md) records the passing backend baseline, requirement-to-test mapping and verification limits on 2026-10-20. Backend Milestones 1–5 are complete; the frontend and packaged-release exit gates below remain outstanding.

- Every Go package: `go test ./...`; run `go test -race ./...` where supported.
- Database integration tests against real PostgreSQL, not mocks for transaction/concurrency invariants. Apply goose up migrations to a clean test database and confirm schema with queries.
- SQL generation: `sqlc generate` and ensure generated files are consistent/compilable.
- API: validate `docs/api/openapi.yaml` and assert implemented status codes and JSON schemas.
- Frontend: TypeScript check, Vitest component tests; Playwright checkout happy and rejection paths.
- Static analysis and dependency checks in CI when configured; never claim to have run tests without actual execution.

## Requirement traceability

| ID | Invariant / requirement | Essential verification |
|---|---|---|
| DB-01 | Unique canonical email | duplicate registration, email normalization |
| DB-02 | Nonnegative inventory, reserved <= on hand | rejected direct invalid inserts/updates |
| CART-01 | One item per product and version increments | concurrent cart mutations |
| CART-02 | Checkout snapshot isolates cart edits | concurrent checkout/cart edit locking |
| ORD-01 | Order >=1 item, immutable prices/address | order history after product/address edit |
| INV-01 | No overselling | 100 concurrent checkouts for last unit |
| INV-02 | Active reservation sum matches aggregate | reconciliation query following all outcomes |
| PAY-01 | Accepted payment consumes only once | repeated settlement / crash retry |
| PAY-02 | Rejected payment releases only once | replay failure |
| PAY-03 | Deterministic result on same attempt | repeated attempt and restart |
| ID-01 | Same key/same request yields same order | sequential and simultaneous retries |
| ID-02 | Same key/changed intent conflicts | modified version/address/scenario |
| ID-03 | Different key same cart version blocked | race two independent requests |
| TX-01 | Failure during T1 leaves no partial state | injected transaction abort |
| TX-02 | Failure between T1 and T2 recoverable | crash fault + recovery CLI |
| TX-03 | Failure during T2 leaves no partial settlement | injected rollback during reservation loop |
| REC-01 | Expired reservation isn't blindly cancelled | stale accepted attempt reconciles to confirmed |
| REC-02 | Recovery reruns safely | apply command twice, same final state |
| SEC-01 | Users cannot access each other's resources | API authorization tests |
| SEC-02 | Customer cannot create admin/modify stock | policy tests |
| AUTH-01 | Refresh session rotation and logout | replay old refresh token rejected |
| API-01 | Contract codes and typed responses | OpenAPI contract tests |
| INIT-01 | Reproducible clean schema | goose up/no-op rerun; 15 domain tables plus metadata; disposable down/reapply |
| AUTH-02 | Strict access token validation and immediate revocation | Wrong algorithm/issuer/audience/type/claims, expired/revoked session, inactive user, role change |
| AUTH-03 | Cookie/CSRF controls and bounded auth work | Origin/header denial, cookie flags, no-store, rate/capacity limits |
| AUTH-04 | Customer and cart creation are atomic | Duplicate signup race and injected cart-insert failure |
| AUTH-05 | Rotation rollback and fixed lifetime | Injected session-update failure; exact PostgreSQL seven-day deadline; one concurrent refresh winner |
| AUTH-06 | Current database state owns authorization | Revocation, expiry, deactivation, role changes, session/subject mismatch, and ignored JWT role claims |
| TX-04 | Lost COMMIT acknowledgement is resolved safely | Same-key lookup/retry; uncertain response never creates a duplicate |
| REC-03 | Recovery diagnostics do not mutate data | Read-only dry-run, concurrent operators, aggregate checks in a consistent snapshot |
| NUM-01 | Bounded arithmetic and JSON-safe values | Quantity/price/total/delta/version boundaries, multiplication/sum overflow, version exhaustion |
| ACCOUNT-01 | Partial profile/address writes preserve omitted fields and ownership | Concurrent disjoint profile edits; strict/null/empty inputs; cross-user address denial; optional text clearing to SQL NULL |
| CATALOG-01 | Products and initial inventory are atomic | SKU conflicts; injected inventory-insert failure; retirement/reactivation; active-only pagination |
| STOCK-01 | Physical stock changes preserve reservations | Concurrent signed adjustments; integer bounds; rejection below reserved stock; customer/admin stock endpoints cannot change reservation counters |
| CART-04 | Cart changes serialize and version once | 30 simultaneous additions; coherent reads; parent lock contention/cancellation; add versus replace; missing/foreign item denial |
| CART-03 | Cart failures leave no partial change | Injected version-write failure; 100 distinct products; quantity bounds; safe-version exhaustion across all mutation types |

## Milestone 6 API alignment coverage

`TestProductSearch` verifies literal active name/SKU matching (case/Unicode/wildcard/escape text), filtering before pagination, stable ties and strict 400/422 grammar. `TestAdminCatalogReads` verifies all three GETs with runtime SELECT grants, current roles/activation, retired visibility without public leakage, coherent concurrent counters, read-only timestamps and safe missing-inventory failures. `TestCartPresentationReadiness` verifies existing cart/product data, a retired line's public 404/removal and high-price/quantity fallback inputs. Unit `TestCatalogQuery`/`TestProductSearchPattern` preserve order pagination and validate catalog-only filters.

These extend the baseline catalog/auth/API requirements above without new schema or cart endpoints. Backend execution/results are in [current project status](../PROJECT_STATUS.md); browser suite/fixture ownership is in the [frontend test plan](../frontend/TEST_PLAN.md).

## Key integration experiments

### Last-item contention

Seed product with `quantity_on_hand=1`, reserved=0; seed 100 separate customer carts and keys each requesting 1 unit. Launch concurrently using barrier start. Assert exactly one pending/confirmed order obtains one reservation, no stock negative, and aggregate constraints hold. Other checkouts receive inventory conflict. Repeat multiple times.

### Duplicate checkout after cart was cleared

Submit checkout; after T1 the cart is empty and its version incremented. Retry same user/key/original `cart_version`, address ID and scenario. Assert 200 with the same order ID, no new order/reservation/payment. Send changed address or scenario with same key: 409. Run simultaneous same-key requests with different database connections.

### Two keys for same cart version

Launch two requests with different keys against one user/cart/version. One may win and create an order. The loser receives 409 stale cart. Assert only one order and no double hold.

### T1 atomic rollback

Seed cart with two products; second product lacks stock. Assert no orders/items/attempts/reservations/idempotency records from failed transaction, and no stock changes.

### T2 crash and replay

After T1, interrupt before the claim, after the claim, and before T2. Assert pending order/active holds and the expected pending/processing attempt. Advance an injected clock or prepare expired timestamps so the order is eligible without sleeping 15 minutes. Run recovery --apply; order confirmed/rejected according to persisted scenario. Run recovery again: no second inventory adjustment or duplicate history entry. Repeat with injected rollback after first reservation is updated but before commit; assert full rollback.

Milestone 3 verifies interruption, explicit service finalization, concurrent matching finalizers, rollback during the reservation loop, terminal-integrity refusal and no simulation on GET/retry. Its HTTP test also keeps the simulator blocked while other requests observe a persisted processing attempt, proving no transaction/connection remains acquired during simulation. These tests do not substitute for the Milestone 4 recovery command/crash-process experiments.

### Commit acknowledgement loss

Inject connection loss around T1 COMMIT, testing both rollback and committed outcomes. Retry the identical user/key/body; assert at most one order. When lookup cannot establish certainty, assert 503 `checkout_outcome_uncertain`, never a claim of guaranteed rollback or an invented pending order. If the order is found, return its durable status. Repeat finalization after uncertain T2 completion and assert no double settlement.

Milestone 3 additionally targets actual PostgreSQL claim/T2/cancellation COMMIT packets: lose the reply after a server-observed commit, close before forwarding commit, and hold an unfinished upstream commit. Verify 201/202/503 checkout responses and 200/503 cancellation responses, identical-key status-only retries, current-state visibility barriers, and exactly-once final stock/history after resolution. Cancellation uncertainty uses `order_outcome_uncertain`; retry the same order's cancellation.

### Recovery ownership and diagnostics

Run two apply commands against the same eligible candidates. Allow repeated deterministic computation of a processing attempt but require exactly-once settlement. Assert bounded visits, no transaction held during simulation, and nonzero exit for inconsistent terminal states. Dry-run must leave statuses/timestamps/counters unchanged. Compare aggregates and links in one consistent read-only snapshot while other transactions settle. GET order/polling and same-key retries must not trigger simulation. Confirm nonexpired pending orders are skipped.

Milestone 4 executes these service/command experiments, plus stable deadline/UUID ordering, SKIP LOCKED, fixed cutoffs, visit limits including corrupt rows, bounded findings with exact totals, inactive-owner recovery, cancellation/output interruption, known-abort retry budgets and claim/T2 socket faults. Process tests kill a separate native test process after its T1 commit, after recovery claim, during the second reservation update of T2, and after T2 commit; a fresh command run completes or observes the terminal result without another inventory/history change. All pause controls exist only in test code. The full race suite and three additional repetitions of every recovery test passed; these are backend/command guarantees, not frontend E2E or Linux/macOS execution claims.

### Cancellation race

Run cancellation and processing claim concurrently. Under shared order lock exactly one decision wins. If cancellation wins, attempt becomes cancelled and reservation released; payment cannot subsequently settle. If payment claims first, cancellation returns conflict and settlement/recovery completes safely.

### Long-term history

Retire product and edit address after checkout; order items keep historical SKU/name/price and the order keeps shipping snapshot. Deactivate customer account; orders remain queryable to authorized admin tooling.

### Authentication and security

M9 password extension: [account-security integration](../../backend/internal/platform/integration/account_security_test.go) covers strict proof/CSRF/input, rate limits/version bounds, atomic password/session rollback, real COMMIT loss and login/refresh/logout/change races. [Foundation](../../backend/internal/platform/integration/foundation_test.go) includes migration 10 up/down/reapply, grants/readiness and nonnegative credential version. Frontend `FE-SEC-01` evidence and remaining SMTP/token scope are in the [password acceptance record](../frontend/TEST_PLAN.md#milestone-9-password-change-progress); historical backend requirement IDs/evidence retain their original scope.

Test Argon2id hash parsing/verification, distinct salts, password bounds and preservation, allocation/concurrency bounds, role enforcement, and unauthorized resource IDs. Test strict JWT signature/algorithm/issuer/audience/type/time/subject/session claims, current user/session checks, immediate logout revocation, deactivation, and role changes. Test atomic refresh rotation (one concurrent winner), stale-token rejection without clearing the winner's cookie, fixed seven-day expiry, cookie attributes in local/HTTPS modes, exact Origin/custom-header enforcement, no-store responses, and bounded rate limiting. Do not put secrets in test logs. No replay-family tracking is claimed by the existing schema.

### API examples and edge cases

Validate concrete Address/Product response objects as well as the OpenAPI document itself; reject extra request properties. Verify root health/metrics paths, metrics admin authorization, logout without a live access JWT, 15-character password minimum, pagination ordering, null/empty PATCH policy, cart add-versus-replace behavior, and all numeric upper bounds. Unit/contract tests cover these choices before frontend flows depend on them.

## Metrics and evidence

Store test environment versions, commands, pass/fail logs, concurrency count, and selected database integrity queries in `docs/backend/evidence/`. Metrics must distinguish target versus observed result. No invented RPS, error-rate, or concurrency success claims.

## Exit criteria

- All required contract and integration tests pass on a clean database.
- T1/T2 invariants and recovery were verified with real PostgreSQL.
- Concurrent tests pass repeatedly, not merely once.
- API implementation matches OpenAPI; frontend builds and critical checkout flows pass E2E.
- No worker/queue/outbox dependency accidentally introduced into Project 1.
- Evidence, outstanding defects, and deviations from this specification documented.
