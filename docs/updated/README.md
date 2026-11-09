# Commerce Lab documentation

A concise rewrite of the project documentation. The original documents in `docs/` remain in place as the detailed historical record; nothing here deletes or replaces them.

Use these documents for the current state. Use the originals for dated evidence, per-task history and the full reasoning behind each decision.

## Start here

| Document | Read it for |
|---|---|
| [STATUS.md](STATUS.md) | What is done, what is left, current versions and verification |
| [OVERVIEW.md](OVERVIEW.md) | Scope, architecture, trust boundaries and exclusions |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Setup, daily commands and tests on Linux |
| [DECISIONS.md](DECISIONS.md) | Key project-wide choices and why |
| [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md) | Task-by-task checklist for the remaining milestones |
| [MILESTONE_14.md](MILESTONE_14.md) | Production serving and HTTPS: design, config contract, gates |
| [MILESTONE_15.md](MILESTONE_15.md) | Observability: OpenTelemetry instrumentation built into the API |
| [MILESTONE_16.md](MILESTONE_16.md) | Final release: image, Compose deployment, evidence, tag |
| [MILESTONE_17.md](MILESTONE_17.md) | Target production shape: SPA on a CDN, API behind an ALB |
| [PORTFOLIO_MASTER_CONTEXT.md](PORTFOLIO_MASTER_CONTEXT.md) | Portfolio strategy: the seven projects, the scenario rule, where this app fits (Project 1) |
| [../../README-MASTER.md](../../README-MASTER.md) | Short portfolio overview |

### Backend

| Document | Covers |
|---|---|
| [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md) | Packages, runtime limits, HTTP surface, error policy |
| [backend/DATABASE.md](backend/DATABASE.md) | Tables, invariants, lock order, grants |
| [backend/CHECKOUT.md](backend/CHECKOUT.md) | Checkout transactions, idempotency, cancellation, state machine |
| [backend/ACCOUNT_SECURITY.md](backend/ACCOUNT_SECURITY.md) | Passwords, JWT, sessions, email verification, reset |
| [backend/GUEST_COMMERCE.md](backend/GUEST_COMMERCE.md) | Guest sessions, carts, checkout, mailbox recovery |
| [backend/OPERATIONS.md](backend/OPERATIONS.md) | Configuration, telemetry, migrations, admin provisioning, order recovery, SMTP |
| [backend/OBSERVABILITY_CONTRACT.md](backend/OBSERVABILITY_CONTRACT.md) | Every span, metric, label and log field the API emits (tested) |
| [backend/TESTING.md](backend/TESTING.md) | Test gates, key experiments and evidence index |

### Frontend

| Document | Covers |
|---|---|
| [frontend/ARCHITECTURE.md](frontend/ARCHITECTURE.md) | Stack, source layout, sessions, routes |
| [frontend/API_INTEGRATION.md](frontend/API_INTEGRATION.md) | HTTP rules, retry policy, cart enrichment |
| [frontend/CHECKOUT_RECOVERY.md](frontend/CHECKOUT_RECOVERY.md) | Browser recovery records, locks, outcome handling |
| [frontend/UI_DESIGN.md](frontend/UI_DESIGN.md) | Visual system, layouts, components, accessibility |
| [frontend/FIXTURES.md](frontend/FIXTURES.md) | Versioned demo data and its lifecycle |
| [frontend/TESTING.md](frontend/TESTING.md) | Vitest, Playwright harness, verification levels |

### Contracts (unchanged)

- [OpenAPI 1.7.0](../api/openapi.yaml): the HTTP contract. 61 business operations plus 3 operational routes.
- [Migrations](../../backend/migrations): the schema authority (version 13).
- [Frontend pins](../frontend/toolchain.json): exact npm dependency versions and scripts.

## Old → new map

| Original | Now covered by |
|---|---|
| `README.md` (root), `frontend/README.md`, `docs/frontend/TOOLING.md` | DEVELOPMENT.md, frontend/TESTING.md |
| `docs/README.md` | This file |
| `docs/OVERVIEW.md`, `docs/backend/OVERVIEW.md`, `docs/frontend/OVERVIEW.md` | OVERVIEW.md, backend/ARCHITECTURE.md, frontend/ARCHITECTURE.md |
| `docs/PROJECT_STATUS.md`, `docs/backend/PROJECT_STATUS.md` | STATUS.md |
| `docs/IMPLEMENTATION_SEQUENCE.md` and backend/frontend sequences | IMPLEMENTATION_SEQUENCE.md, STATUS.md |
| `docs/IMPLEMENTATION_DECISIONS.md` and backend/frontend decisions | DECISIONS.md plus the topic documents |
| `docs/HANDOFF_PROMPT.md` | STATUS.md, IMPLEMENTATION_SEQUENCE.md |
| `docs/backend/DATABASE_SCHEMA.md` | backend/DATABASE.md |
| `docs/backend/CHECKOUT_DESIGN.md` | backend/CHECKOUT.md |
| `docs/backend/RECOVERY.md`, `docs/backend/OPERATIONS.md` | backend/OPERATIONS.md |
| `docs/backend/ACCOUNT_SECURITY_DESIGN.md` | backend/ACCOUNT_SECURITY.md |
| `docs/backend/GUEST_COMMERCE_DESIGN.md` | backend/GUEST_COMMERCE.md |
| `docs/backend/TEST_PLAN.md`, `docs/backend/evidence/*` | backend/TESTING.md (evidence files are linked, not copied) |
| `docs/frontend/API_INTEGRATION.md` | frontend/API_INTEGRATION.md |
| `docs/frontend/CHECKOUT_RECOVERY_DESIGN.md` | frontend/CHECKOUT_RECOVERY.md |
| `docs/frontend/UI_DESIGN.md`, `frontend/FRONTEND_UI_DESIGN.md`, `SHOPPING_EXPERIENCE.md`, `VISUAL_ACCEPTANCE.md`, `M13_DESIGN_ACCEPTANCE.md` | frontend/UI_DESIGN.md |
| `docs/frontend/FIXTURES.md`, `fixtures/README.md` | frontend/FIXTURES.md |
| `docs/frontend/TEST_PLAN.md` | frontend/TESTING.md (dated evidence stays in the original) |

## Conventions

- Milestone numbering: here, M14 is production serving and HTTPS, M15 is observability, M16 is the final baseline release, and M17 is the CDN and load-balancer deployment. The original `docs/` still describes a single M14 release milestone.
- Facts here were checked against the code on 2026-11-07. Where an original document disagrees (for example, older text says schema 11 or OpenAPI 1.5.0), these documents and the code win.
- Commands are Bash, run from the repository root unless stated. Windows scripts now live in `scripts/win64/`.
- Never copy values from `.env`, `.cache/fixtures/` or any credential bundle into documentation.
