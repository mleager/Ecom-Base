# Backend verification evidence

These are dated records of executed checks. Earlier reports intentionally retain their original scope/completion statements; use [current backend status](../PROJECT_STATUS.md) for the present state.

| Report | Coverage |
|---|---|
| [Milestone 1 foundation](MILESTONE_1_FOUNDATION.md) | Schema, runtime, migration and health foundation |
| [Milestone 1 authentication](MILESTONE_1_AUTHENTICATION.md) | Passwords, sessions, cookies, JWT and authorization |
| [Milestone 1 commerce](MILESTONE_1_COMMERCE.md) | Account, addresses, catalog, stock and cart |
| [Milestone 2 checkout](MILESTONE_2_CHECKOUT.md) | Atomic T1, snapshots, contention, idempotency and uncertain commit |
| [Milestone 3 payment](MILESTONE_3_PAYMENTS.md) | Claim, simulation, settlement, cancellation and HTTP |
| [Milestone 4 recovery](MILESTONE_4_RECOVERY.md) | Explicit command, diagnostics, concurrency, process crashes and reruns |
| [Milestone 5 consolidated verification](MILESTONE_5_BACKEND_VERIFICATION.md) | Fresh combined backend checks, all 36 requirement IDs, frontend readiness and remaining gates |

The reports moved from `docs/evidence/` to `docs/backend/evidence/` on 2026-10-20. Original dates/results and executed command text are preserved. Recorded old layout references are historical; current commands belong in the repository README and [recovery guide](../RECOVERY.md). Documentation relocation does not constitute a fresh integration/race run. The Milestone 5 report separately records the fresh consolidated run on 2026-10-20.
