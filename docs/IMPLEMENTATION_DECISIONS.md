# Shared Implementation Decisions

**Updated:** 2026-10-30 (America/New_York).  
**Scope:** Project-wide boundaries. Detailed backend reasoning is in [backend decisions](backend/IMPLEMENTATION_DECISIONS.md); frontend reasoning is in [frontend decisions](frontend/IMPLEMENTATION_DECISIONS.md).

## Documentation ownership

Keep project scope, milestone ordering and completion summaries at the top level. Backend design/status/evidence live under `docs/backend/`; frontend scope/tasks/decisions/integration live under `docs/frontend/`. [OpenAPI](api/openapi.yaml) remains the one shared wire contract in its existing location.

The [documentation map](README.md) explains what to read by task. Link to detailed authority rather than copying its full contents. Backend evidence retains original verification dates/results and historical commands. Frontend plans do not constitute implemented features or passing tests. Update both sides and OpenAPI when a cross-boundary contract changes.

**Reason:** Focused documents reduce unrelated context and avoid duplicate sources of truth.

## Application and trust boundaries

Use the approved Go/chi/pgx/sqlc/goose/PostgreSQL backend and Vite/React/TypeScript frontend. The browser owns presentation and input, while the backend/database own authorization, inventory, totals, snapshots and state transitions. USD, US addresses and simulated payments remain the Project 1 baseline. Do not introduce distributed-payment infrastructure or unrelated Amazon features by analogy with its visual design.

Authentication uses in-memory access tokens and an HttpOnly refresh cookie. Existing server session checks, CSRF/origin requirements and refresh rotation remain authoritative. Frontend routing/role checks improve UX; server enforcement remains required. Detailed browser behavior is mapped in [API integration](frontend/API_INTEGRATION.md).

Checkout retries retain the original customer-scoped key and request intent. Pending/uncertain results require truthful UI states; the browser cannot declare success, invent rejection or start a replacement checkout to resolve uncertainty. GET/replay observe status; recovery remains an explicit operator command.

**Reason:** A richer interface must preserve the backend reliability guarantees and security model already tested.

## Milestone 5.1 scope baseline

Scope amendment (2026-10-25): Milestone 9 includes authenticated password changes, email delivery/verification, verified email changes and emailed forgotten-password recovery, superseding the original exclusion. The [ten-step sequence](frontend/IMPLEMENTATION_SEQUENCE.md#milestone-9--account-addresses-and-cart) owns delivery order and the [security acceptance criteria](frontend/OVERVIEW.md#scope-and-acceptance-baseline) own outcomes. Task 2 is complete: the [account-security design](backend/ACCOUNT_SECURITY_DESIGN.md) selects SMTP through the Go standard library, explicit delivery configuration, current-password checks, dual-mailbox email changes, opaque expiring single-use tokens, legacy verification enrollment, all-session credential revocation and concrete schema/API/test gates. No queue/outbox/provider SDK is selected; mailbox credentials and receipt proof remain task 4 execution inputs. Design completion does not implement the features, automatically verify existing accounts or change current OpenAPI/schema/configuration. Preserve historical evidence and update backend/frontend/OpenAPI with each implementing increment. Tasks 3–6 now implement password changes, SMTP, current-email verification, verified email changes and forgotten-password recovery with schema 11/OpenAPI 1.5.0. Controlled-mailbox receipt and authenticated link use are confirmed; recovery uses the same delivery configuration. Combined acceptance remains task 10.

Customer/admin feature outcomes and exclusions are defined once in the [frontend acceptance checklist](frontend/OVERVIEW.md#scope-and-acceptance-baseline). The [frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md#dependencies-and-acceptance-ownership) owns implementation dependencies; the completed Milestone 5.4 [integration audit](frontend/API_INTEGRATION.md) maps current operations and specifies bounded future work.

Require minimal literal case-insensitive active-product name/SKU search, authenticated carts with truthful product/price estimates, and admin retired-product/inventory reads. The selected contracts and bounded cart-read strategy live in the integration audit; implementation remains Milestone 6 and the owning UI milestones. Keep additional Amazon features outside scope rather than rendering nonfunctional controls. Health/metrics/provisioning/recovery remain operator workflows. The audit changes documentation only.

**Reason:** Explicit outcomes, exclusions and owners let later increments proceed without expanding the domain accidentally or mistaking plans for working integration.

## Development tooling and contract changes

Continue using installed local Go/goose/sqlc binaries and PostgreSQL-only Compose during development. Verify and pin Node/package-manager/frontend dependencies when setup begins; their availability/versions are not assumed by these documents. Approved frontend test tools are Vitest and Playwright; no additional service is selected here.

Known frontend/API gaps are tracked in [API integration](frontend/API_INTEGRATION.md). Confirm the smallest required design change, update OpenAPI, implement it in the existing backend, and add tests before the affected UI depends on it. Existing schemas/behaviors are not silently changed by a frontend plan.

## Visual design and release ordering

Selected 2026-10-30: keep M11 administration and functional hardening, add M12 for the shared CSS/visual refresh across customer/admin screens, and move the former M12 release to M13 at that time. Confirm a basic visual direction before new administrator screens, then complete post-polish responsive/accessibility and browser regressions before packaging. The [frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md#milestone-12--visual-design-and-polish) owns incremental tasks; use the existing CSS architecture and approved stack rather than adding a styling framework or unrelated feature.

**Reason:** A dedicated visual pass keeps functional work reviewable and ensures the final image/tag contains the accepted appearance and behavior. Historical backend evidence retains its original verification dates/results and milestone labels.

## Shopping scope amendment — 2026-11-02

The user adds M13 for modern responsive shopping, hover/touch/keyboard quick view, a single resulting-quantity selector, improved contextual shipping, guest cart/checkout without an account and Tailwind CSS/shadcn/ui. Final packaging/tagging moves to M14. [Selected revision](frontend/SHOPPING_EXPERIENCE.md) and the [eleven-task sequence](frontend/IMPLEMENTATION_SEQUENCE.md#milestone-13--shopping-experience-and-guest-checkout) supersede the earlier guest exclusion and CSS-only restriction. Current code/API/schema/package pins remain unchanged by this plan.

The initial accept-only proposal was **superseded later on 2026-11-02**: retain explicit customer-selected deterministic acceptance/rejection to demonstrate both settlement paths in the portfolio. The selected scenario stays in the immutable original request; existing backend simulation/idempotency/recovery remains authoritative. Guest ownership, protected credentials, cart identity transitions, direct shipping snapshots and secure return/order access still need contracts/tests before closing GAP-08. [Current visual authority](../frontend/FRONTEND_UI_DESIGN.md) also selects mint styling, right mini-cart with read-only quantities, optional free-text labels with Home placeholder and current-cart-only checkout presentation. Admin search extends the existing admin list with the catalog's bounded literal q rules; no label enum/migration or new payment policy is required.

## Final release and Projects 2–6

The owner requires the tagged container release to be the final step after the complete frontend/backend application is verified. That release is the healthy reusable Project 1 baseline for modified scenario variants in Projects 2–6. This supersedes the older overview's placement of release inside Milestone 5.

Planned packaging is one Go application image containing built React assets and the API, with PostgreSQL as a separate Compose service. This uses the approved stack without selecting a new reverse proxy. Packaging is future implementation work; migration execution remains explicit, and secrets/live database contents stay outside images. Record source/release identity, image digest, schema and fixture versions; isolate later scenario faults in their variants.

Production mode currently validates configuration and enables Secure cookies; the API still uses a plain HTTP listener. The final release must establish and verify HTTPS delivery, compatible browser/API host/origin settings and secure-cookie operation. Exact serving/certificate configuration remains release implementation work within the approved stack. A production environment flag alone does not establish a secure or verified deployment.

**Reason:** One tested baseline makes later deployment/recovery exercises reproducible and keeps their deliberate failures out of the healthy application.
