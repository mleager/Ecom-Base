# Project 1 — Commerce Reliability Lab

**Updated:** 2026-11-02 (America/New_York).  
Backend M1–5 and frontend M6–12 retain their accepted baseline. M13 Tasks 1–5 are complete, including guest checkout and recovery in API 1.7.0 with readiness 13. Tasks 6–11 own frontend lifecycle and shopping acceptance. [Project status](PROJECT_STATUS.md)

Build a working e-commerce application whose correctness comes from Go services and PostgreSQL transactions. Project 1 must include a functioning Vite/React/TypeScript frontend connected to the backend before it is complete.

## Scope and architecture

| Component | Responsibility | Detailed documentation |
|---|---|---|
| Vite/React/TypeScript client | Amazon-inspired browsing, identity, account/addresses, cart, simulated checkout, orders and administrator screens | [Frontend overview](frontend/OVERVIEW.md) |
| Go/chi backend | Authentication/authorization, validation and application transaction boundaries | [Backend overview](backend/OVERVIEW.md) |
| pgx/sqlc/PostgreSQL | Durable data, inventory reservations, idempotency, snapshots and guarded settlement | [Physical schema](backend/DATABASE_SCHEMA.md), [checkout design](backend/CHECKOUT_DESIGN.md) |
| Explicit recovery command | Inspect and finish eligible interrupted orders using persisted deterministic outcomes | [Recovery guide](backend/RECOVERY.md) |
| Shared REST contract | Browser/backend agreement on schemas and behavior | [OpenAPI](api/openapi.yaml), [integration mapping](frontend/API_INTEGRATION.md) |

The browser is untrusted. Prices, stock, ownership, roles and payment outcomes are enforced by the backend/database. Project 1 uses USD, US shipping addresses and deterministic simulated payments. It does not collect real card data.

Included customer journeys are registration/login/logout, authenticated password changes, email delivery/verification, verified email changes and emailed password recovery, public product previews/details and keyword search, profile/address management, a persistent authenticated cart, simulated checkout and durable order history/status. M13 adds guest shopping/purchase without an account, direct required shipping/contact, modern responsive interactions and Tailwind/shadcn components; current implementation/acceptance is pending for that amendment. Administrator journeys cover product/inventory operations with usable retired-product and stock reads. [Frontend scope/acceptance criteria](frontend/OVERVIEW.md#scope-and-acceptance-baseline) are authoritative for these outcomes and exclusions; [gap dispositions](frontend/API_INTEGRATION.md#scope-gap-dispositions--milestone-51) assign missing contract/setup work before dependent UI. Search/admin-read extensions are implemented and backend-tested; cart presentation uses bounded existing reads. Password/email/security/recovery and SMTP are implemented and accepted through M9–12; the M13 guest expansion needs its own design and acceptance.

Real payment providers, tax/shipping-rate computation, coupons, reviews/ratings, recommendations, Prime, marketplaces, refunds, complex fulfillment, multiple currencies/warehouses, queues, outbox tables, Redis and distributed workers remain outside this baseline. Guest cart/checkout is approved M13 scope; silent merging remains deferred. Social login, role-management UI, image uploads/galleries and category/faceted/relevance search are also deferred. Amazon-inspired means familiar shopping interaction and presentation with this application's own branding, within the stated scope. M9 task 2 selected [SMTP delivery through the Go standard library](backend/ACCOUNT_SECURITY_DESIGN.md#delivery-configuration-failure-and-abuse-budgets), without a provider SDK or additional infrastructure. M9 implemented delivery/verification, email changes and recovery; controlled-mailbox receipt/link use and combined acceptance are recorded in its evidence.

## Development and final release

Use local Go/goose/sqlc tooling; Docker currently runs PostgreSQL only. The locally installed Node 24.20.0/npm 11.19.0 and exact dependencies/commands are selected in [frontend tooling](frontend/TOOLING.md). The frontend is accepted through M12; the M13 scope amendment is planned before final release in M14.

The tagged container release is the final step after frontend/backend/browser verification. It will be the healthy, versioned application baseline for scenario variants in Projects 2–6. The planned packaging is a Go application image serving the built frontend/API, with PostgreSQL as a separate Compose service; packaging is not implemented by this documentation change. Keep credentials and live database contents outside images. Project 7 retains the distributed-payment scope.

## Completion and ownership

The [project milestone sequence](IMPLEMENTATION_SEQUENCE.md) delegates detailed work to backend/frontend documents. [Shared decisions](IMPLEMENTATION_DECISIONS.md) govern cross-system policies. Backend reports are evidence of executed checks, while frontend plans are requirements until their tests exist and pass.

Project 1 completes only after backend and frontend acceptance criteria, real browser flows, operations/recovery checks and the final packaged-release gates pass. A completed backend milestone or documentation section alone does not complete the project.
