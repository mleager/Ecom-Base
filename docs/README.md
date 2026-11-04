# Documentation map

Start with [project status](PROJECT_STATUS.md) and read the documents for the task at hand. Detailed backend and frontend plans have separate homes; project-wide summaries stay here.

| Area | Start here | Authority |
|---|---|---|
| Whole project | [Overview](OVERVIEW.md), [milestones](IMPLEMENTATION_SEQUENCE.md), [status](PROJECT_STATUS.md) | Scope, ordering, completion and release gates |
| Shared policies | [Implementation decisions](IMPLEMENTATION_DECISIONS.md) | Cross-system boundaries and final baseline release |
| HTTP contract | [OpenAPI](api/openapi.yaml) | Implemented wire schemas, authentication, responses and numeric bounds |
| Backend | [Backend index](backend/README.md) | Detailed service/database design, milestone history, verification and operations |
| Frontend | [Frontend overview](frontend/OVERVIEW.md) | Planned pages, user journeys and visual scope |
| Current visual specification | [FRONTEND_UI_DESIGN.md](../frontend/FRONTEND_UI_DESIGN.md) | Mint palette, page presentation, simulation choices and simplified cart/checkout decisions; implementation remains milestone-owned |
| Frontend work | [Frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md) | Milestones 6–13, acceptance criteria/progress and the M14 release handoff |
| Browser integration | [API integration](frontend/API_INTEGRATION.md) | Endpoint-to-screen mapping, browser behavior and identified API gaps |
| Shopping revision | [M13 scope](frontend/SHOPPING_EXPERIENCE.md), [visual preview](frontend/M13_DESIGN_ACCEPTANCE.md), [guest contracts](backend/GUEST_COMMERCE_DESIGN.md) | Tasks 1–5 complete. Task 6 owns frontend guest integration. |
| Visual acceptance | [Milestone 12 review](frontend/VISUAL_ACCEPTANCE.md) | Page/state coverage, executed visual/native evidence, limits and the M14 release handoff |
| Account security | [Selected M9 design](backend/ACCOUNT_SECURITY_DESIGN.md) | Password/email/recovery policies, planned contracts/migrations, SMTP configuration and test gates; not implemented behavior |
| Frontend choices | [Frontend decisions](frontend/IMPLEMENTATION_DECISIONS.md), [tooling](frontend/TOOLING.md), [UI design](frontend/UI_DESIGN.md), [test plan](frontend/TEST_PLAN.md), [fixtures](frontend/FIXTURES.md) | Browser policies, verified exact tooling selections, routes/layouts and remaining implementation decisions |

## Reading by task

- Backend changes: read the backend sequence/status and relevant design/test sections. Consult OpenAPI for HTTP changes.
- Operator work: read the [operator guide](backend/OPERATIONS.md) for local setup/credentials/migrations/provisioning, then [recovery](backend/RECOVERY.md) for reconciliation.
- Frontend changes: read the current frontend milestone and relevant integration/decision sections. Load backend internals only when the task changes or depends on their behavior.
- Cross-system changes: update the shared contract, affected implementation documents and project summary together.
- Release work: read project-wide decisions/status and current backend/frontend evidence; final packaging happens after the application is complete.

Detailed frontend progress belongs in its sequence. Backend verification history belongs in [backend evidence](backend/evidence/README.md). Project status contains rollups and links rather than copies of those details.

The documentation split on 2026-10-20 preserves the earlier backend reports and their original verification dates. Their recorded commands/results are historical evidence. The current README and runbooks own present-day execution instructions. The reorganization itself added no application functionality or fresh verification.

Milestone 5 establishes backend readiness through the [consolidated verification report](backend/evidence/MILESTONE_5_BACKEND_VERIFICATION.md). Frontend Milestones 6–12 are complete, including [isolated fixtures](frontend/FIXTURES.md), authentication, catalog, account/security, cart/checkout/orders, administrator/global functional acceptance and [final visual acceptance](frontend/VISUAL_ACCEPTANCE.md). M13 [shopping/guest revision](frontend/SHOPPING_EXPERIENCE.md) is in progress; M14 retains final packaging/deployment/tagging after its acceptance. See [application setup](../frontend/README.md), [current status](PROJECT_STATUS.md) and the [project sequence](IMPLEMENTATION_SEQUENCE.md).
