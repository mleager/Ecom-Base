# Backend documentation

Backend Milestones 1–5 are complete; the [consolidated verification report](evidence/MILESTONE_5_BACKEND_VERIFICATION.md) records the current baseline and remaining frontend/release gates. [Project-wide status](../PROJECT_STATUS.md) and [ordering](../IMPLEMENTATION_SEQUENCE.md) summarize frontend and release work separately.

| Document | Purpose |
|---|---|
| [OVERVIEW.md](OVERVIEW.md) | Runtime architecture, trust boundaries and domain guarantees |
| [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | Current 21-table schema, readiness 13, constraints and permissions |
| [CHECKOUT_DESIGN.md](CHECKOUT_DESIGN.md) | T1/claim/T2, cancellation, idempotency and recovery rules |
| [GUEST_COMMERCE_DESIGN.md](GUEST_COMMERCE_DESIGN.md) | M13 selected guest/session/cart/checkout/mailbox/admin-search contracts, migration plan and acceptance gates; implementation pending |
| [IMPLEMENTATION_DECISIONS.md](IMPLEMENTATION_DECISIONS.md) | Detailed backend choices and rationale |
| [ACCOUNT_SECURITY_DESIGN.md](ACCOUNT_SECURITY_DESIGN.md) | Selected M9 password/email/recovery design, SMTP configuration, planned contracts/migrations and implementation/test gates; not implemented behavior |
| [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md) | Backend milestone scope and progress |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Detailed backend completion and executed verification commands |
| [TEST_PLAN.md](TEST_PLAN.md) | Backend requirement traceability and verification gates |
| [OPERATIONS.md](OPERATIONS.md) | Local setup/configuration, migrations, administrator provisioning, health and troubleshooting |
| [RECOVERY.md](RECOVERY.md) | Operator recovery commands, outputs and safe reruns |
| [Evidence](evidence/README.md) | Dated executed test reports; original outcomes retained |
| [Shared OpenAPI](../api/openapi.yaml) | Authoritative HTTP contract consumed by backend and frontend |

These documents moved into this directory on 2026-10-20. Commands and implementation paths are repository-relative unless explicitly stated otherwise. Historical milestone sections/reports describe their completion state at that time; current status is maintained separately. The move changes documentation organization, not runtime behavior or verification history.
