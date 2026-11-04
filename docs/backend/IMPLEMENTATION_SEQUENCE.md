# Backend Implementation Sequence

Accepted backend choices and rationale are in [implementation decisions](IMPLEMENTATION_DECISIONS.md). This document owns detailed backend Milestones 1–5; [project sequence](../IMPLEMENTATION_SEQUENCE.md) owns overall ordering, and frontend tasks live in the [frontend sequence](../frontend/IMPLEMENTATION_SEQUENCE.md). Backend completion/evidence are maintained in [backend status](PROJECT_STATUS.md).

**NOTE:** Update `./PROJECT_STATUS.md` file after every incremental update to a milestone.

Milestones 1–4 below retain their historical completion snapshots. Later milestones supersede statements that a feature was still disabled or future work at an earlier completion point. Documentation relocation on 2026-10-20 does not re-date executed evidence.


## Milestone 1 — Core database

Root Go 1.25.1 module, `postgres:16-alpine`, Compose, goose, sqlc, configuration, and all 13 approved tables

- Five dependency-ordered migration groups with indexes/constraints alongside their tables
- Runtime/health foundation, then identity/catalog/cart APIs and their tests
- Explicit migration execution, disposable integration databases, and recorded environment versions/digests

Progress: **complete**. Foundation, registration/login/refresh/logout/authorization, profile updates, owned address CRUD, public catalog/admin product and inventory APIs, and persistent cart APIs are implemented and tested with local Go/goose/sqlc tooling and PostgreSQL-only Compose. Migrations 6–7 add column-scoped permissions without changing the 13-table schema. Native checks/build, PostgreSQL integration/race tests, repeated cart/stock concurrency tests, and disposable migration down/reapply passed. See [PROJECT_STATUS.md](PROJECT_STATUS.md) and `evidence/MILESTONE_1_{FOUNDATION,AUTHENTICATION,COMMERCE}.md` for scope and executed evidence. Checkout, payment simulation and recovery remain later milestone work.


## Milestone 2 — Transactional orders

Complete T1 using orders/items/reservations, checkout idempotency, the initial payment attempt, and status history

- Atomic order creation, cart snapshots, concurrent checkout safety, commit-uncertainty handling
- Verify through service integration tests; do not expose an incomplete checkout endpoint

Progress: **complete**. `checkout.Service.CreatePending` implements the full atomic pending-order graph, snapshots, stock holds and cart consumption. Retained-intent replay, customer/key serialization, 100-customer last-unit contention, cart-edit races, rollback injection, bounded PostgreSQL retries and real COMMIT acknowledgement-loss cases passed with the race detector and three additional repetitions. Migration 8 adds T1 permissions without new tables. See [PROJECT_STATUS.md](PROJECT_STATUS.md) and [checkout evidence](evidence/MILESTONE_2_CHECKOUT.md). Payment processing and checkout HTTP remain disabled until Milestone 3.


## Milestone 3 — Simulated payment

Processing claim transaction, deterministic simulator, T2, and cancellation

- Accept/reject outcomes and atomic reservation consumption or release
- Persisted processing ownership, cancellation races, guarded transitions/history, and complete checkout HTTP responses

Progress: **complete**. The authenticated checkout/order/payment routes now coordinate T1, a committed processing claim, simulation outside a transaction, and guarded T2/cancellation. Real PostgreSQL tests verify acceptance/rejection, concurrent finalization/cancellation, 100-customer HTTP last-unit contention, partial-loop rollback, corruption refusal and claim/T2/cancellation COMMIT acknowledgement loss. The full race suite and three additional repetitions passed; migration 9 adds column-scoped settlement permissions without new tables/dependencies. See [PROJECT_STATUS.md](PROJECT_STATUS.md) and [payment evidence](evidence/MILESTONE_3_PAYMENTS.md). GET/retry do not resume processing; explicit recovery remains Milestone 4.


## Milestone 4 — Failure recovery

Recovery CLI and reconciliation queries

- Idempotent finalization, stale order recovery, crash testing, no reservation leaks
- Read-only dry-run, bounded SKIP LOCKED processing, consistent diagnostic snapshots, and no expiry-based forced release

Progress: **complete**. The explicit `backend/cmd/reconcile` command defaults to dry-run and supports bounded apply, one cutoff, ordered cursor/SKIP LOCKED candidate ownership, pending claims and deterministic processing-attempt resumption. It reuses existing exactly-once settlement and safely resolves or reports uncertain commits. Read-only global diagnostics retain bounded examples and exact totals without repairs. Native checks/builds, real PostgreSQL race tests, four actual subprocess-kill boundaries and three additional repetitions of all recovery tests passed. Schema remains version 9; no migration, runtime dependency or infrastructure component was added. See [operator instructions](RECOVERY.md), [PROJECT_STATUS.md](PROJECT_STATUS.md), and [recovery evidence](evidence/MILESTONE_4_RECOVERY.md).


## Milestone 5 — Documentation and evidence

Finalize backend documentation and establish readiness for frontend implementation

- Maintain clear scope, architecture/schema/state diagrams and engineering rationale.
- Review HTTP integration needs, operator instructions and requirement-to-test evidence.
- Consolidate backend verification before frontend work; the final tagged application release follows frontend acceptance.

Progress: **complete** (2026-10-20). Scope, architecture/schema, decisions, the [frontend/API audit](../frontend/API_INTEGRATION.md), [operator instructions](OPERATIONS.md) and [recovery runbook](RECOVERY.md) are reviewed. The [consolidated report](evidence/MILESTONE_5_BACKEND_VERIFICATION.md) maps all 36 backend requirements to tests and records passing native checks/builds, the full PostgreSQL race/crash suite, contract/document checks and verification limits. Schema remains version 9 with 13 domain tables. Milestone 6 design/API alignment is next, including the selected search/admin-read work. Frontend acceptance and the final tagged application release remain outstanding; the temporary subtask checklist is retired.
