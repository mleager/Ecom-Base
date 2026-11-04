# Project Implementation Sequence

This document owns project-wide ordering. Detailed tasks, acceptance criteria and progress live in the linked backend/frontend sequences. [Project status](PROJECT_STATUS.md) is the completion rollup.

| Milestone | Outcome | Status / detailed plan |
|---|---|---|
| 1 — Core database and services | Schema/toolchain/runtime, identity, account, catalog and cart | Complete; [backend sequence](backend/IMPLEMENTATION_SEQUENCE.md) |
| 2 — Transactional orders | Atomic T1 snapshots, reservations, intent and cart consumption | Complete; [backend sequence](backend/IMPLEMENTATION_SEQUENCE.md) |
| 3 — Simulated payment | Claim, deterministic simulation, T2, cancellation and checkout/order HTTP | Complete; [backend sequence](backend/IMPLEMENTATION_SEQUENCE.md) |
| 4 — Failure recovery | Explicit recovery CLI, diagnostics, concurrency and crash proof | Complete; [backend sequence](backend/IMPLEMENTATION_SEQUENCE.md) |
| 5 — Backend documentation and readiness | Architecture, decisions, integration needs, runbooks and consolidated evidence | Complete; [verification report](backend/evidence/MILESTONE_5_BACKEND_VERIFICATION.md); [backend plan](backend/IMPLEMENTATION_SEQUENCE.md#milestone-5--documentation-and-evidence) |
| 6 — Frontend design and API alignment | Page/route design, verified tooling/fixtures and bounded API-gap work | Complete; versioned fixtures verified; [frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md) |
| 7 — Frontend foundation and authentication | Application shell, typed API integration, session lifecycle and protected pages | Complete; auth acceptance verified; [frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md) |
| 8 — Storefront and catalog | Product previews/details, scoped keyword search and pagination | Complete; catalog acceptance verified; [frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md) |
| 9 — Account, addresses and cart | Profile editing, password/email security and emailed recovery, address CRUD and persistent cart | Complete; profile/security/recovery, owned addresses and storefront/cart acceptance verified; [ten-step sequence](frontend/IMPLEMENTATION_SEQUENCE.md#milestone-9--account-addresses-and-cart) |
| 10 — Checkout and orders | Correct simulated checkout/retries, order history/status and cancellation | Complete; seven requirement IDs and `GAP-06` accepted; [nine-task frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md#milestone-10--checkout-and-orders), [acceptance evidence](frontend/TEST_PLAN.md#milestone-10-acceptance) |
| 11 — Administration and application hardening | Product/stock administration, accessibility and real browser regression coverage | Complete; all twelve tasks and [functional acceptance/handoff](frontend/TEST_PLAN.md#milestone-11-functional-acceptance-and-visual-polish-handoff) recorded; [frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md#milestone-11--administration-and-application-hardening) |
| 12 — Visual design and polish | Shared CSS/visual system, consistent customer/admin presentation and responsive/accessibility regressions | Complete; all eight tasks and [visual acceptance/handoff](frontend/VISUAL_ACCEPTANCE.md) verified; [frontend visual plan](frontend/IMPLEMENTATION_SEQUENCE.md#milestone-12--visual-design-and-polish) |
| 13 — Shopping experience and guest checkout | Tailwind/shadcn responsive UI, quick view, quantity/address flows, guest purchase, admin search and retained accept/reject simulation | In progress; Task 2 foundation complete/verified, other ten tasks pending. [Eleven-task sequence](frontend/IMPLEMENTATION_SEQUENCE.md#milestone-13--shopping-experience-and-guest-checkout) and [scope/design](frontend/SHOPPING_EXPERIENCE.md) |
| 14 — Final reusable baseline release | Packaged polished application, deployment verification and immutable release evidence | Not started; follows M13 acceptance and release gates below |

Implement one independently reviewable increment at a time. Add appropriate tests and update the owning plan/status alongside the work. Backend progress is summarized by milestone; detailed frontend acceptance remains in its own documents.

## Dependency gates

Backend readiness and frontend Milestones 6–11 are complete; checkout/order acceptance closes `GAP-06`, and M11 records administration/global functional acceptance and the visual handoff. M12 owns the CSS/visual refresh and repeats responsive/accessibility and critical browser regressions, beginning with visual direction. M13 adds the approved guest shopping, mint Tailwind/shadcn, admin search and checkout-presentation revision, retaining both payment scenarios; M14 packages/tags the accepted revised baseline. The [frontend sequence](frontend/IMPLEMENTATION_SEQUENCE.md), [scope](frontend/OVERVIEW.md#scope-and-acceptance-baseline), [gap ownership](frontend/API_INTEGRATION.md#scope-gap-dispositions--milestone-51) and [current status](PROJECT_STATUS.md) own detailed evidence; a plan is not proof of implementation.

Milestone 14 starts only after backend/frontend acceptance through M13 and integration evidence are complete. The visual milestone added on 2026-10-30 first moved release from M12 to M13. On 2026-11-02 the shopping/guest revision becomes M13 and moves release to M14. Earlier backend evidence retains its original milestone numbers and recorded results. Project 1 completes only when its packaged-release gates also pass. Later Projects 2–6 derive controlled variants from that frozen healthy release; their scenario faults are outside Project 1's scope.

## Final release gates — Milestone 14

1. All backend/frontend milestones through M13, customer/admin endpoint mappings and post-polish regressions are verified, with unresolved limitations recorded.
2. The production frontend builds and the application image serves it and the Go API correctly, including direct page navigation and preserved API/operational routes.
3. Compose deployment, explicit migrations, readiness, real browser journeys and recovery pass against an owned test database. Credentials/live data remain outside images; no development volume reset is part of release verification.
4. Record tested tool/image versions, source/release identity, fixtures, image digest and reproducible operating instructions. Keep schema and fixture versions identifiable for later scenarios.
5. Tag the healthy Project 1 application baseline. Projects 2–6 derive scenario variants without changing that baseline's healthy behavior.

No application container, deployment, publishing, tagging or scenario fault is introduced during documentation reorganization. Exact release commands/artifact identities will be recorded when this milestone is implemented.
