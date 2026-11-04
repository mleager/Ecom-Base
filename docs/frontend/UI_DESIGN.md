# Frontend routes and interaction design

**Selected:** 2026-10-21 (America/New_York), Milestone 6 task 2.

This document remains the design authority for frontend routing, authentication boundaries, session management, API interaction behavior, navigation state, authorization, and established reliability requirements.

[Frontend overview](OVERVIEW.md#scope-and-acceptance-baseline) owns feature requirements, [API integration](API_INTEGRATION.md) owns wire behavior and integration gaps, and [tooling](TOOLING.md) owns dependencies and development commands.

## Design Authority and Documentation Precedence

**Updated:** 2026-11-02 (America/New_York), Milestone 13.

The frontend redesign is defined across complementary documents, each with a specific responsibility.

### Visual Design Authority

M13 Task 1's [design acceptance and interactive preview](M13_DESIGN_ACCEPTANCE.md) finalize the revised layouts and measurable handoff criteria. They are isolated design evidence; real migration and guest/admin-search acceptance remain Tasks 3–11.

[FRONTEND_UI_DESIGN.md](../../frontend/FRONTEND_UI_DESIGN.md) defines the approved frontend visual design and presentation requirements, including:

- Global color palette, typography, spacing, and component styling.
- Header, navigation, catalog, and product-card presentation.
- Cart, account, shipping-address, and checkout layouts.
- Administrator page styling and navigation improvements.
- Responsive behavior and shared UI interaction states.

Its mint-green palette and approved component styling supersede the earlier Milestone 12 lime-green visual direction.

Earlier visual specifications remain documented as historical implementation decisions but are not authoritative where the updated design explicitly replaces them.

### Shopping Experience Authority

[SHOPPING_EXPERIENCE.md](SHOPPING_EXPERIENCE.md) defines the approved Milestone 13 functional shopping requirements, including:

- Guest identity, cart ownership, and persistence.
- Guest checkout without account registration.
- Guest shipping information and secure order access.
- Signed-in and guest shopping transitions.
- Explicitly selectable deterministic payment acceptance/rejection for portfolio demonstrations.
- Shopping interactions and application-wide Tailwind/shadcn adoption.

The explicit palette and product-card hover decisions in `FRONTEND_UI_DESIGN.md` supersede the earlier visual proposals in `SHOPPING_EXPERIENCE.md`. Other functional requirements remain governed by the shopping specification.

### Existing Technical and Reliability Requirements

This document and the established backend/API specifications retain authority over:

- React Router routes and validated navigation.
- Authentication, session restoration, and authorization.
- API request handling and error classification.
- Checkout idempotency, persistence, and recovery.
- Inventory reservations and stock adjustments.
- Uncertain mutation handling and explicit reconciliation.
- Cross-tab coordination and private-data protection.
- Accessibility and security requirements.

Visual changes must not bypass existing security, transaction, or reliability guarantees.

Functional changes require their corresponding backend and API contracts to be updated and verified.

## Implementation Status

**Milestone 12:** Completed and accepted as the preceding visual implementation baseline. [Visual acceptance](VISUAL_ACCEPTANCE.md) records its verification.

**Milestone 13:** In progress. The Tailwind/shadcn foundation and initial controls have their own verification evidence. Full UI migration, guest checkout, and revised payment-policy behavior require their respective implementation and acceptance tasks.

The updated `FRONTEND_UI_DESIGN.md` describes the intended final UI, not functionality already proven to exist.

**Milestone 14:** Packaging and release activities follow successful completion and acceptance of Milestone 13.

Implementation should follow [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md), with acceptance and regression requirements tracked in [TEST_PLAN.md](TEST_PLAN.md).

When specifications overlap, apply the authority assigned above. Any unresolved conflict involving security, data ownership, or transaction correctness must be resolved before implementation rather than overridden by a visual requirement.

---

**Selected:** 2026-10-21 (America/New_York), Milestone 6 task 2. This remains the design authority; M7 completed foundation/auth acceptance on 2026-10-24. Later feature pages retain their milestone owners. [Frontend overview](OVERVIEW.md#scope-and-acceptance-baseline) owns feature requirements, [API integration](API_INTEGRATION.md) owns wire behavior/gaps, and [tooling](TOOLING.md) owns dependencies/commands.

**Design review:** 2026-10-31, M12 task 1 confirmed complete. The reference choices, semantic palette, typography/spacing/imagery, shared states and responsive customer/admin layouts below form the finalized implementation direction. Tasks 2–7 implement it; task 8 verifies rendered acceptance. No application styling is changed by this review.

**Current design status (2026-11-02):** M12 remains the preceding visual implementation. [Visual authority](../../frontend/FRONTEND_UI_DESIGN.md), [shopping policy](SHOPPING_EXPERIENCE.md) and [Task 1 acceptance](M13_DESIGN_ACCEPTANCE.md) finalize the mint preview/layouts. Tasks 1–4 are complete within their scopes; [Task 4](TEST_PLAN.md#milestone-13--guest-carts-and-admin-search) adds backend guest sessions/carts/choice and admin q. Guest checkout/lifecycle and production visual integration/acceptance remain Tasks 5–11. Both simulations and established financial/session guarantees remain; M14 packages the revised baseline afterward.

Task 2 implements the [Tailwind/shadcn foundation](TOOLING.md#m13-tailwindshadcn-foundation) and initial Field/search/authentication controls, with verification tracked in the [test plan](TEST_PLAN.md#milestone-13--tailwindshadcn-foundation). The proposed full layouts, guest behavior and revised checkout presentation remain later tasks; this increment preserves the current page structure and business contracts.

The [application-wide component map](SHOPPING_EXPERIENCE.md#application-wide-component-coverage) is required M13 coverage for shell/banner/search, catalog/cards/details, cart, shipping/checkout/orders, account/security, administration and all shared states. Task 1 finalizes it; Tasks 7–10 migrate their assigned areas and Task 11 audits complete coverage. Tailwind styles semantic layout; shadcn primitives provide appropriate reusable presentation/interactions. The initial Button/Input slice does not satisfy full application migration.

Current implementation: M8 provides public listing/details/search and state coverage, with final acceptance journeys at 360/1280px and long-text/breakpoint checks at 360/480/1024/1280px. Catalog links have 44px minimum height; skip navigation preserves loaded data/URLs, and POP scroll restoration waits for results and yields to new user interaction. `q`/`offset` history and detail returns remain validated. Busy/status semantics, distinct empty/missing/failure/image states and explicit delayed retry remain covered. M9 tasks 8–9 implement the cart page, storefront purchase controls and shared quantity-sum header badge. The designs below describe the full application target. M11 task 2 adds protected administrator browsing with responsive table/header semantics, explicit status/page-size controls and role/lifecycle-safe reads; [scoped evidence](TEST_PLAN.md#milestone-11-product-browsing-progress) is distinct from the later visual refresh. M11 task 10 consolidates native customer/admin keyboard journeys at 360/1280px, labelled controls, sampled text/focus contrast, history and bounded failure/uncertain-write states. Its original white-header focus treatment is superseded by M12's selected blue outline/dark gap across the current dark header/search surfaces. [Interaction evidence/limits](TEST_PLAN.md#milestone-11-application-wide-interaction-progress) retains the earlier scope; M12 subsequently completes [visual acceptance](VISUAL_ACCEPTANCE.md); earlier evidence retains its dated scope.

## Example UI Styling

The reference discussion and M12 palette/layout sections below preserve historical decisions and evidence. Current mint styling, page-specific presentation and the revised mini-cart/checkout rules are governed by the linked frontend design authority above.

User-supplied references, selected 2026-10-31. These unchanged documentation copies replace machine-specific paths and keep the direction reviewable with the project. They are visual references, not production assets or API/feature requirements; their original provenance is not established here. Keep Commerce Lab branding and the existing first-party product assets.

| Reference | Adopt | Adapt to approved scope |
|---|---|---|
| [Dark storefront](references/dark-mode-ui-blog-banner.png) | Near-black page, charcoal image/card surfaces, generous product imagery, restrained lime accents and clear price hierarchy. Primary visual reference. | Use existing search/pagination and purchase controls. Omit bestseller/category/brand/sort filters, sale/rating/favorite controls and the surrounding device/browser artwork. |
| [Cart and checkout](references/dark-mode-ui-cart.jpg) | Grouped item rows, outlined dark fields, separated summaries, prominent total and a clear main action. | Preserve owned-address review and labelled simulated accept/reject choices. No card/wallet/provider fields, coupons, recommendations, tax/shipping-fee claims or real-charge language. Blue informs link/focus styling rather than a second purchase-action color. |
| [Compact catalog](references/dark-mode-ui-catalog-example.jpg) | Compact name/price/action hierarchy, aligned product rows and understated separators. | Retain readable system typography and modern spacing; do not copy the tiny text/low contrast, sale prices, sidebar widgets or unsupported navigation. |

## Milestone 12 visual direction

**Design selected (2026-10-31), M12 task 1.** Build a dark Commerce Lab storefront with restrained lime primary actions, cool blue underlined links/focus and consistent charcoal surfaces across customer/admin pages. The first reference anchors the palette; the other two guide grouping and density. Tasks 2–6 implement shared foundations, the shell and customer page families; task 7 retains administrator targets and task 8 accepts the complete rendered result. This section supersedes the original light palette and 8px card-radius target while retaining existing interaction/API contracts.

### Palette and surface roles

Use semantic variables in the existing [global stylesheet](../../frontend/src/styles.css), consumed by current CSS Modules. Keep existing variable names where their role remains valid; add explicit on-primary, secondary-text, state and raised-surface roles instead of scattering hex values or inheriting white text on lime buttons. A single dark appearance is selected; no theme switch, preference storage, remote font or styling dependency is added. Task 2 applies native dark control/color-scheme treatment and verifies rendered controls plus Chromium-forced autofill state; actual password-manager/OS autofill remains outside that bounded proof.

| Target token / role | Value | Usage |
|---|---|---|
| `--color-page` | `#0B0D0F` | Page canvas. |
| `--color-header` | `#101215` | Shared navigation and minimal-page brand area. |
| `--color-surface` | `#15181C` | Cards, forms, order summaries and notices. |
| `--color-surface-raised` | `#1D2228` | Product-image panels and nested/hover surfaces. |
| `--color-text` | `#F2F5F7` | Primary text and prices. |
| `--color-text-muted` | `#A5AFBA` | Supporting text, labels and metadata; not reduced-opacity body text. |
| `--color-border` | `#73808C` | Required field/control outlines and meaningful boundaries; layout grouping may use spacing instead. |
| `--color-primary` | `#D7F23B` | Main deliberate action and selected-state emphasis. |
| `--color-primary-hover` / `--color-primary-active` | `#E6FF64` / `#BED629` | Enabled primary hover/pressed states. |
| `--color-on-primary` | `#141907` | Text/icons on all lime primary states. |
| `--color-link` | `#9ACBFF` | Underlined text links and secondary navigation emphasis. |
| `--color-focus` | `#B5D9FF` | Visible keyboard focus, normally 3px with 3px offset onto a dark surrounding surface. |
| `--color-error` | `#FFB4AB` | Definitive errors/destructive-action text with explicit labels. |
| `--color-success` | `#9FE3B1` | Confirmed success with status text. |
| `--color-warning` | `#F3D38A` | Pending/uncertain/review-required notices; never imply rollback or failure. |
| `--color-disabled` | `#2C333B` | Disabled controls with muted text and an explanation; avoid fading the whole control/panel. |

Calculated opaque sRGB pairings (rounded minima): primary text 14.62:1, secondary text 7.20:1 and links 9.42:1 across the four dark surfaces above; state text 9.43:1. On-primary text 10.96:1 across normal/hover/pressed lime. Control borders against the raised surface are 3.96:1; focus against it is 10.93:1; disabled text/background is 5.74:1. These calculations validate proposed pairs only. Actual adjacent surfaces, autofill, overlays, selected states and native controls must be checked after implementation. Keep text ≥4.5:1 and meaningful boundaries/focus ≥3:1; use a dark separating halo if a light focus ring would touch a lime surface. No reliance on hue alone, subtle low-contrast fields, gradients, transparency or glow to establish meaning.

### Typography, spacing and imagery

Keep the installed system sans-serif stack: body/labels/actions 1rem with 1.5 line height; supporting metadata at least 0.875rem; page headings 1.75rem narrow/2.25rem wide, section headings 1.25rem and prices approximately 1.25–1.5rem. Use medium/semibold weights for hierarchy rather than condensed display fonts or uppercase paragraphs. Money/counter columns may use tabular numerals; preserve integer-cent formatting and natural text wrapping.

Retain spacing tokens 4/8/12/16/24/32px, centered 80rem content and at least 16px side gutters. Use 16px card padding narrow/24px wide, 16–24px grid gaps, 12px card/panel radii and 8px control radii. Reserve pill shapes for small status/quantity badges; use at least 44px action targets. Separate dark regions by spacing, surface level and meaningful outlines rather than heavy shadows.

Product panels use stable contained image boxes (square previews; detail images retain their natural aspect within a bounded area). Keep existing SVGs, their authored colors and existing fallback behavior; do not recolor, darken or invert product imagery to fit the theme. White-backed images remain readable framed assets. Screenshots, brand logos and photography from the references do not replace product data or enter the production public tree.

Task 4 applies square shared preview frames, a detail-only 4:3 frame capped at 32rem with contained natural image proportions, stable fallback panels and 12px cards. Existing one/two/four-column catalog breakpoints remain; preview actions align at the card bottom. SKU/load metadata uses muted supporting text, prices use prominent tabular numerals, and stock states retain explicit wording. Detail price/stock/purchase guidance precedes long descriptions. Existing query/result text and secondary Previous/Next links are grouped without introducing filters, sorting or catalog-total claims. [Rendered evidence and limits](TEST_PLAN.md#catalog-and-product-presentation--task-4) include shared cart/checkout image regression; those pages' overall polish remains task 6.

### Shared visual states

| State | Visual rule and retained interaction |
|---|---|
| Default / hover / pressed | Lime primary action with dark text; secondary controls use dark fill/outlined boundaries and light text. Hover changes surface/border without layout shift. Preserve explicit action labels. |
| Keyboard focus / selected | Distinct focus outline separate from hover/selection. Selected radio/filter controls retain native semantics and text/check indication; focus is never conveyed by color alone. |
| Disabled / loading | Dark disabled fill, readable label and adjacent reason/status. Keep dimensions stable and labelled progress; do not show an unknown badge/price/stock as zero or expose private content before identity verification. |
| Validation / destructive confirmation | Visible labels, error-colored field outline plus linked text/focused summary; explicit danger text for delete/retire/cancel. Inline confirmation/Keep or Cancel remains operable. |
| Success / pending / uncertain | Text-labelled green confirmation or amber pending/review-required notice on a dark surface. Uncertain-write instructions stay prominent, with existing readback/Resume behavior and no automatic resubmission. |
| Empty / unavailable / failed read | Clear heading/message and supported next action; preserve missing-product fallbacks/removal and distinguish empty data from failed reads. |

Reserve lime for the main forward action within a form, product card or purchase section. Back, Reload, Keep and Cancel confirmation controls use the outlined secondary treatment. Destructive actions such as Delete address, Retire product and Cancel order use error-colored text on a dark outlined control, with an explicit verb and the existing confirmation; do not style their final confirmation as an ordinary lime purchase action. Color never replaces action wording, confirmation or state guidance. Keep disabled treatment consistent across primary, secondary and destructive actions.

Minimal verification/email/reset pages use the same tokens and compact forms without adding the shopping header, remote imagery or new data reads. Avoid motion by default; any later transition must respect reduced motion and cannot delay focus/status feedback.

Task 5 implements one shared form CSS module: single-column 40rem-capped layouts, consistent spacing and 44px links, full-width submission on narrow screens, grouped profile metadata and separate labelled security panels. Pending-email cancellation stays beside its proof/expiry metadata. Address cards use 12px raised surfaces, responsive padding and distinct Add/Edit/Delete/Confirm actions. Shared notice links also have 44px targets. Existing field labels/autocomplete, validation/focus, loading/disabled/uncertain guidance, inline confirmation and private/session/proof lifetimes remain intact. [Form verification](TEST_PLAN.md#account-and-form-presentation--task-5) separates public visual previews from native private-state/layout checks and final milestone acceptance.

Task 6 applies 12px line/recovery/summary panels, 16/24px padding, readable metadata and prominent labelled estimates/authoritative totals. Cart/checkout use stacked narrow layouts and a 20rem summary from 64rem; shipping/simulation review and confirmation are capped at 40rem. Native radio selection and no-real-charge wording remain explicit. Order item/shipping snapshots precede the payment/cancellation panel in document order and sit beside it at wide widths. Status colors accompany authoritative wording; a saved reference alone never implies payment success. [Purchase verification](TEST_PLAN.md#cart-checkout-and-order-presentation--task-6) separates invented-data visual previews from native transaction, ownership, recovery and cancellation proof. Existing budgets and deliberate-write rules remain intact.

## Milestone 12 entry handoff

**Ready (2026-10-31):** M11 functional acceptance is [complete](TEST_PLAN.md#milestone-11-functional-acceptance-and-visual-polish-handoff), including all 30 scope IDs and 38 business-operation owners. M12 subsequently completes all eight tasks; [visual acceptance](VISUAL_ACCEPTANCE.md) records the implemented foundations, shell, customer/admin pages and final regression evidence. Existing first-party Commerce Lab branding/assets and the current CSS architecture remain the starting point; no new framework or business capability is selected.

- Start shared tokens/layouts in [styles.css](../../frontend/src/styles.css), the [shopping shell](../../frontend/src/shared/ui/StoreLayout.module.css), [field styles](../../frontend/src/shared/ui/Field.module.css) and existing feature CSS modules. [routes.tsx](../../frontend/src/app/routes.tsx) is the actual page-family inventory; minimal email/recovery pages remain outside the shopping shell. Keep SessionBoundary/AdminBoundary and the shared cart/recovery lifetimes intact.
- Review normal, long-content, loading, empty, validation/conflict, unavailable, pending and uncertain outcomes at 360/1280px and relevant intermediate widths. Preserve semantic headings/labels/announcements, keyboard/focus/error recovery, readable contrast and action targets; record actual visual/accessibility limits. Honor reduced motion where motion is used.
- Keep deliberate writes, confirmation/reconciliation instructions, simulated-payment labels and stock-counter distinctions visible. Styling must preserve send-once writes, exact-key recovery, durable handoff, bounded observation, immutable snapshots and private-state clearing; it must not add decorative unsupported actions or real-payment claims.
- Re-run affected checks incrementally and the [required full regression](TEST_PLAN.md#verification-levels) for shared styles and M12 acceptance. Task 11's passing gates establish the functional entry baseline, not proof that future styling passes. Track the existing chunk warning and clock mitigation in the [outstanding-items record](TEST_PLAN.md#outstanding-issues-and-environment-limits); M14 retains packaged serving/HTTPS/tagging.

## Shell, navigation and routes

Current M9 security implementation: `/account/security` provides password changes, email verification and verified email-change request/replacement/cancellation. One bounded status read supplies delivery availability, owned pending metadata and both mailbox flags. Minimal `/verify-email` and `/confirm-email-change` scrub fragment/query data before auth, offer inline sign-in/current-password confirmation and retain route-bound proofs only in volatile memory. Reopening an email through same-document navigation captures a fresh intent; reload/navigation/identity changes discard it. These pages have no catalog header/images. The first change proof preserves the current email; the second signs out every session and requires new-email login. Duplicate conflicts close the request without changing credentials; an uncertain potentially final response hides private state and offers deliberate recovery. Minimal public `/forgot-password` and `/reset-password` pages now provide non-disclosing requests and explicit password replacement without requiring a session. Confirmed reset broadcasts only security-changed and rechecks each tab, preserving unrelated accounts. Uncertain resets discard intent and offer deliberate login/checking.

M9 shipping addresses: Account links to the owned address book, with responsive cards, standalone create/edit routes, field-linked errors and explicit inline delete/cancel controls. Editing selects an ID from the owned list and preserves omitted fields; optional label/line 2 can be cleared. Success uses returned server values; bodyless deletion reloads the list. Uncertain writes never replay, and explicit reload/review is required before another change. Address data stays within the private route lifetime.

M9 profile increment: `/account` now edits first/last names in the shared single-column form layout, retaining read-only email/account type. Field errors link from a focused summary; success is announced and updates the header. Saving disables controls; an unconfirmed outcome requires Reload profile before further saving, with an explicit warning that reload replaces unsaved edits. Shipping-address navigation is available from Account; signed-in order navigation is available in the shared header.

M9 task 2 selects the [security browser/link design](../backend/ACCOUNT_SECURITY_DESIGN.md#browsersession-integration-and-link-safety). `/account/security`, `/verify-email` and `/confirm-email-change` are implemented, with volatile route-bound proofs and explicit confirmation. `/forgot-password` and `/reset-password` are implemented; public reset preserves unrelated accounts through coordinated session observation. The task 4 external delivery/receipt prerequisite is satisfied. Name editing remains separate from credential operations.

Use **Commerce Lab** as the working storefront name, retaining Project 1's own branding. The shopping header contains the brand/home link, labelled search, account/sign-in link, orders link for signed-in users, and cart link with the server-derived quantity-sum badge. Administrators additionally see Products administration. Logout is an explicit account action; a failed logout does not claim server revocation. There are no decorative location, Prime, category, review or delivery controls without supported behavior.

Use React Router declarative nested routes: `StoreLayout` supplies the shared shopping/auth/account/order/administrator shell; administrator pages reuse it through `AdminBoundary` with admin-local components/styles. The implemented routes do not introduce a separate AdminLayout component. `SessionBoundary` waits for restoration on protected pages; `AdminBoundary` also requires the current server-authorized role. Public browsing remains usable while restoration runs. Protected data requests wait for an identified user; cached private views are cleared on identity changes. Guards improve UX; the Go API still enforces ownership/role.

Route parameters below are UUIDs; invalid syntax shows a missing/invalid resource view without an unnecessary request. Foreign/missing owned resources share a non-disclosing missing view. These are **browser routes**, not new API paths.

| Browser route | Access / page and main actions | Owner |
|---|---|---|
| `/` | Public catalog; search, pagination, product previews and detail links. | M8 |
| `/products/:productId` | Public product detail; explicit quantity/add-to-cart controls. Guests get a sign-in return path without an automatic purchase. | M8/M9 |
| `/signup` | Public customer registration form; success offers deliberate login. No role selector or implicit login. | M7 |
| `/login` | Public login; accepts validated `returnTo` from protected navigation. | M7 |
| `/account` | Session required; first/last-name editing, read-only email/account type and explicit profile reload. Shipping-address navigation is available here; orders and logout remain available in the shared header. | M7/M9 |
| `/account/security` | Session required; password change with current-password proof, confirmation, all-session sign-out and deliberate login. Implemented in M9 task 3; email controls follow their working APIs. | M9 |
| `/account/addresses` | Session required; owned address cards, add/edit/delete actions. | M9 |
| `/account/addresses/new` | Session required; labelled US address form. | M9 |
| `/account/addresses/:addressId/edit` | Session required; load owned address list and select ID, then PATCH. There is no address-detail GET in the API. | M9 |
| `/cart` | Session required; line quantities/removal, clear, estimated totals and checkout link. | M9 |
| `/checkout` | Session required; recovery/recheck, owned review, simulation, deliberate placement/Resume, durable handoff, conflict retirement and order links. Task 8 adds bounded pending status observation and manual checks after stopping. | M10 |
| `/orders` | Session required; paginated owned history, status and detail links. | M10 |
| `/orders/:orderId` | Session required; immutable snapshots, safe payment panel, confirmed eligible cancellation and same-order uncertainty reads. Task 8 adds bounded pending observation with lifecycle/deadline/read limits and manual checks after stopping. | M10 |
| `/admin` | Current admin required; retain the established access landing with account/home navigation and a working Browse products link. M11 task 2 preserves this verified entry contract instead of the former redirect proposal. | M7/M11 |
| `/admin/products` | Current admin required; active/retired/all browsing and URL-owned pagination. Product names lead to read-only details, metadata/confirmed availability editing and inventory adjustments; Create product opens its separate form. Navigation preserves list context. | M11 |
| `/admin/products/:productId` | Current admin required; reads active/retired product fields and inventory with distinct missing/failed states. Task 5 connects Edit product; detail/inventory/editor/list links preserve context. | M11 |
| `/admin/products/new` | Current admin required; Task 4's supported-field form validates exact cents/Unicode bounds, creates an active product with zero stock and displays canonical server values. Detail/inventory links read current state. Uncertain POSTs lock this form and offer explicit all-status SKU-page inspection without replay or rollback claims. | M11 |
| `/admin/products/:productId/edit` | Current admin required; changed-field metadata PATCH plus Task 6's separate confirmed retirement/reactivation actions. Dirty metadata blocks status confirmation. Status writes use fresh same-ID GET before enabling changes; unknown writes or failed observations require explicit readback without replay/transaction-identity claims. Stock remains untouched. | M11 |
| `/admin/products/:productId/inventory` | Current admin required; coherent counters and Task 7's confirmed signed deltas for active/retired products. Show observed projections and authoritative returned/current snapshots separately; errors/uncertainty require fresh reads and operator review before a blank new intent. No reservation editing, automatic replay/compensation or zero-delta read substitute. | M11 |
| Any unmatched path | Missing-page view with home navigation; do not turn unknown API failures into an empty shopping page. | M7 |

Anonymous protected navigation goes to `/login?returnTo=...` only after restoration finishes. Allow `returnTo` only for recognized same-origin application paths with valid permitted query keys; reject absolute/protocol-relative URLs, backslashes, auth-loop destinations and API paths. Never place credentials or form payloads in URLs. Successful login uses replace-navigation to the validated destination or `/`; authorization still applies. Returning to a product after login never automatically replays an add or checkout. Already signed-in visitors to signup/login return to a valid destination rather than seeing a second identity form. A customer visiting an admin URL sees a forbidden view, not an endless login loop.

M7 task 5 establishes `GET /users/me` verification before protected content mounts. Failed reads hide private pages and offer explicit retry without mislabelling network/503 responses as anonymous. The keyed private subtree and `usePrivateSession()` own drafts/requests; shared cart state is separately pinned to the session revision. Identity/role changes clear private state; submitted cart writes can finish through same-identity navigation without replay. Authentication returns follow implemented catalog/product, account/security/addresses, cart/checkout/orders and administrator routes. Orders accept validated pagination; administrator list/detail/inventory/create/editor routes accept validated status/limit/offset context. Availability confirmations live inside the existing editor, with no extra return destination. Every destination rejects credential/payload parameters and fragments; unimplemented adjustment routes remain outside the allowlist. M11 task 8 verifies this policy across all six administrator destinations and seven operations, including actual database session/role changes, obsolete drafts and forged browser claims; see [authorization evidence](TEST_PLAN.md#milestone-11-administrator-authorization-progress). Server authority applies per request; the UI detects changes through existing checks/notifications, without new polling.

The catalog URL uses optional `q` and `offset` (page size 20); changing submitted search resets offset to zero. Trim/validate the documented 200-code-point search before requests, keep the exact submitted term in the URL, and rehydrate it on back/forward. No client-only search of the loaded page. Order history uses `offset`; the admin list uses optional `is_active=true|false` (omitted means all), `limit` (default 20, maximum 100) and `offset`, as implemented by [admin query validation](../../frontend/src/features/admin/adminQuery.ts). The UI offers page sizes 20/50/100 and preserves other valid limits in URLs. Unknown/repeated/malformed browser query values show an invalid-filter state with a reset link; pass only whitelisted API parameters. Full pages offer Next, earlier pages offer Previous, and no page/total count is invented. An empty later page retains Previous. Search/admin reads and their browser screens are implemented; the frontend API inventory owns operation coverage.

M10 task 7: `/orders` preserves offset-only history navigation; details render immutable item/shipping snapshots without current catalog/address enrichment. Safe payment fields include reference, status, creation time and failure code when supplied. Cancellation requires observed eligibility and a focused confirmation region, with Keep order restoring control focus. Unknown/conflicting results read the same order once, retain uncertainty for failed/pending reads and offer only explicit same-order retry. Private page lifetime/visibility guards cancel obsolete requests. This increment provided manual Check Status; Task 8 adds the bounded observation below. [Order evidence](TEST_PLAN.md#milestone-10-order-management-progress) records verified scope.

M10 task 8: known-order checkout and direct details share initial status verification and pending-only automatic continuation. Status notices explain automatic/stopped state and manual Check Status. Ten-second logical reads are clipped to a sixty-second window; three-second completion spacing and twenty actual order/payment attempts include auth replay/fallback. Terminal/failure/blur/hidden/pagehide/navigation/identity/unavailable references stop and cancel reads. Foreground return and manual checks never restart the loop. Cancellation review stops it before mutation. Pending/timeout is not failure, and last snapshots/locators remain available. [Observation evidence](TEST_PLAN.md#milestone-10-observation-progress) records the scoped proof.

## Responsive layouts and visual rules

Use the selected [dark visual tokens and scale](#milestone-12-visual-direction) with mobile-first CSS/rem units, a centered 1280px maximum content width and 16px minimum side padding. Long names/SKUs and failure/recovery messages wrap without document overflow. Keep the existing one-column catalog below 480px, two columns from 480px and four from 1024px; at intermediate widths prioritize readable controls over copying the reference density. Do not add filter/sidebar controls merely to occupy desktop space.

| Page family | Narrow layout (360 CSS px acceptance) | Wide layout (1280 CSS px acceptance) |
|---|---|---|
| Shell/catalog | Brand, labelled search and wrapping navigation in DOM/keyboard order; full-width search when needed, all account/cart actions visible. One image-led card per row remains the catalog target. | Brand/search tier above wrapping navigation, aligned with the main container. Catalog target: four contained-image panels with aligned title/price/availability and lime purchase actions. |
| Product detail | Image, heading/description, price/availability and purchase controls stack in document order. | Large image/content region beside a distinct charcoal purchase panel; clear price/quantity/action hierarchy without fabricated ratings/discounts. |
| Account/addresses/auth | Compact charcoal forms with persistent labels, outlined fields and stacked actions; forms capped at 640px. | Account content and address cards use consistent surfaces/grouping; security notices and destructive controls remain distinct. Minimal proof pages stay outside the shell. |
| Cart/checkout | Item rows, address/review then summary/action; controls wrap with full labels. Cart remains editable; checkout retains its existing review/edit-navigation boundary. | Grouped main content beside an approximately 320px charcoal summary, prominent estimate/authoritative total and labelled simulation actions. Sticky content must not obscure focus or recovery notices. No card/payment-provider panel. |
| Orders | Owned history cards; snapshots precede payment/status, uncertainty notices and eligible cancellation. | Aligned history rows and two-column detail/summary grouping; preserve immutable fields and readable pending/recovery instructions. |
| Admin | Labelled dark product/inventory cards and stacked fields/actions. | Semantic tables and charcoal metadata/inventory panels using the same tokens; group on-hand/reserved/available counters with explicit labels and signed adjustment confirmation. Narrow views retain all labels/actions. |

```text
Wide catalog                          Narrow cart
+---------------------------------+   +------------------------+
| Brand  [ Search        ][Search] |   | Brand                  |
| Home Account Orders Cart ...    |   | [ Search     ][Search] |
| Catalog title / search result   |   | Home Account Cart ...  |
| [card] [card] [card] [card]      |   | Cart heading           |
| [card] [card] [card] [card]      |   | [item / qty / remove]  |
| Previous                   Next |   | [item / unavailable]   |
+---------------------------------+   | Estimated summary      |
                                      | [Proceed to checkout]  |
                                      +------------------------+
```

Task 3's shell refinement keeps brand → search → navigation in both visual and keyboard order; links wrap onto additional rows instead of being hidden or visually reordered. A current-route border/underline, fully wrapping verified-account greeting and known/updating/unavailable quantity badge use the shared tokens. Header/main gutters share `--shell-gutter`; the search component owns its own CSS Module. See [shell verification](TEST_PLAN.md#application-shell--task-3). The catalog/cart content in the diagram remains its page-polish target, not additional task 3 implementation.

The palette above is the sole M12 color authority and matches all 17 implemented color tokens. Administrator presentation uses 12px panels, 16/24px responsive padding, wrapping 44px actions and forms capped at 40rem. Product cards retain table semantics below the existing 768px table breakpoint; prices align with tabular figures in wide rows. Explicit Active/Retired labels supplement success/warning colors. Coherent on-hand/reserved/available counters stack below 480px and form three columns above it; unknown inventory remains an error rather than invented zero stock. Signed-change and availability confirmations use raised warning panels, with existing validation, pending, denial and uncertain-write controls intact. [Administrator evidence](TEST_PLAN.md#administrator-presentation--task-7) distinguishes inspected appearance and native behavior from the task 8 whole-application acceptance gate. Task 8 [final visual acceptance](VISUAL_ACCEPTANCE.md) verifies this baseline; recheck affected rendered states after future changes.

## Components and interaction states

Shared UI roles include the header/search, page headings, pagination, product cards/images, money, fields, error summaries, notices/loading, confirmation/status and layout/session boundaries. Feature roles include purchase controls, address/product forms, cart lines/summaries, checkout review, payment display and stock adjustments. Some roles live inside page components rather than separately named exports; follow the actual source instead of adding abstractions to match this list. Keep feature requests/state in auth/catalog/account/cart/checkout/orders/admin modules behind one typed API boundary. CSS Modules isolate component styles; global CSS owns tokens/reset/focus rules.

| State | Required behavior |
|---|---|
| Loading/restoring | Labelled progress with stable layout; no flash of another user's data, misleading zero badge or active duplicate submit. |
| Empty/not found | Contextual message and valid next action. Empty lists differ from failed requests; a full-page 404 differs from an unavailable cart line. |
| Input failure (400/422/413) | Preserve nonsecret input, show safe server guidance and an error summary. Backend errors have `{code,message}`, not a field-error map: associate a field only when the known error identifies it; otherwise use the summary. |
| Unauthorized/forbidden | Existing reads and name-only profile PATCH permit at most one coordinated same-identity renewal after definitive 401. Commerce, checkout, administrator and security writes send once without authentication replay. Expired session clears private state; role denial hides privileged content while retaining useful navigation. Preserve M7 coordination and current feature-specific session rules. |
| Conflict (409) | Explain stock/cart/SKU/claim conflicts, refresh the appropriate data deliberately, preserve safe form values and require another explicit submission when needed. |
| Network/server/uncertain | Keep a retry path for reads, respect throttling/backoff, and distinguish a failed read from a possibly committed write. Checkout/cancellation use their retained original identity; no generic automatic mutation replay. |
| Success/bodyless response | Announce completion using `role=status`. Handle 204 without JSON parsing and refetch cart/address state as required. Never show successful payment solely because HTTP returned 201. |

Use semantic landmarks, one page h1, a skip link, visible labels, keyboard navigation and at least 44px action targets. On route navigation update the document title and focus the page heading/main region; back/forward retains useful query/scroll context. Failed forms focus the error summary and link to identifiable fields. Confirm clear-cart, address deletion and product retirement with an inline confirmation/cancel pair, without inaccessible modal behavior. Announce cart/stock updates without stealing focus. Tests must exercise narrow/wide layouts, keyboard focus, accessible names and failed images.

Cart enrichment follows the existing bounded strategy: at most 100 distinct product IDs, four reads concurrently and a 10-second overall deadline. Unavailable lines retain product ID, quantity and removal; an unknown price is not zero. A subtotal is a complete estimate only when every line is priced and checked arithmetic succeeds. The UI's prices/availability never reserve inventory or override checkout. M6 validates data/fixture assumptions; M9 task 8 implements/proves request budgets and cancellation at `/cart`.

Current cart UI: signed-in header navigation opens `/cart`; each line has distinct Add quantity and Set quantity actions plus removal. Inputs accept whole quantities 1–10000; Add must also fit the resulting total. Failed/slow product reads retain usable quantity/removal controls; known unavailable products retain removal with ID/image fallback. Reload replaces quantity drafts/current rows, uncertain writes require explicit review and clear uses inline confirm/cancel. Responsive lines precede a summary at narrow widths and use the 320px summary column at 1024px and wider. Quantity submission preserves focus when disabling caused focus loss; write failures focus the shared error summary and removal returns otherwise-lost focus to Reload cart. Task 9 connects preview/detail purchase controls and the quantity-sum header badge to the same snapshot; M10 task 4 adds Proceed to checkout review for a nonempty confirmed cart.

M13 target: checkout shows only current-cart review/form data with explicit simulated acceptance/rejection and no card form. Guests provide contact/US shipping directly; signed-in users select/create owned shipping contextually and labels remain optional free-text with Home placeholder. Prior-order panels are absent; contextual unresolved/rejected-intent guidance preserves blocking/retirement rules. Known orders reach durable handoff before navigation to owned details/status; a fresh cart read/review gates a subsequent purchase. The following M10/M12 technical behavior remains authoritative for unchanged reliability guarantees; [M13 scope](SHOPPING_EXPERIENCE.md#project-1-payment-policy) retains both scenarios and original-intent immutability. The [M10 design](CHECKOUT_RECOVERY_DESIGN.md) selects persistence/coordination/cleanup. Tasks 2–4 implement persistence, protected recovery status/recheck and current-cart/owned-address review. Review order validates explicit choices and shows a volatile summary without placing an order; Refresh checkout review clears choices and rereads prices/addresses/cart. Unresolved or unreadable recovery blocks the form. Known orders require deliberate new review; task 6 requires durable verified rejection and explicit **Retire rejected checkout and review again** before a fresh form. Retirement clears choices and creates no key or checkout request. Fixed conflict guidance links to cart/address/shopping correction; exhausted cart versions block new submission without a reset. Task 5 adds Place simulated order, explicit original-key/body Resume, durable known-order handoff and one initial/manual Check Status read. Loading/uncertain outcomes retain the original intent; 403/idempotency conflict suspend Resume. Outcome/error headings restore otherwise-lost focus. Task 7 adds owned history/detail/payment and explicit confirmed cancellation with same-order uncertainty reads. Task 8 implements bounded automatic observation. The following full submit/observe behavior remains the acceptance target. Unresolved intent blocks new checkout and offers explicit **Resume Original Checkout**, explaining that it may submit the original request if no order committed and does not freeze current price/address values. A known returned order must reach a durable `known_order` handoff before navigation/observation; fresh cart read/review gates the next deliberate purchase. Storage/coordination errors preserve/block and offer recovery guidance plus owned history. GET/poll never starts recovery or converts expiry into rejection; manual **Check Status** follows bounded observation without silently restarting it. Orders render immutable snapshots independently of current catalog/address availability, and cancellation always targets that same order.

## Acceptance scenarios and evidence

These scenarios cover the 30 current feature IDs, including four newly approved M9 security criteria. M7's four auth criteria have [passing evidence](TEST_PLAN.md#milestone-7-acceptance), and M8 catalog checks have an [acceptance mapping](TEST_PLAN.md#milestone-8-acceptance). All feature rows now have [M11 final outcomes](TEST_PLAN.md#milestone-11-functional-acceptance-and-visual-polish-handoff); M12 repeats final visual/accessibility review after styling. Use component checks for local rendering/form/state and Playwright with real Go/PostgreSQL for persisted behavior, roles and transactions. The [API audit](API_INTEGRATION.md#endpoint-to-interface-inventory) retains per-operation ownership.

| Feature IDs | Observable scenario / owner |
|---|---|
| `FE-AUTH-01`, `FE-AUTH-02` | Register a customer, explain duplicate/invalid/throttled input, deliberately log in and return to a safe destination; no role selection or automatic purchase. M7. |
| `FE-AUTH-03`, `FE-AUTH-04` | Reload with a cookie; coordinate overlapping refreshes; logout, expire/revoke/change users and verify private cart/account/order data disappears. Lost refresh/logout responses have truthful bounded handling. M7. |
| `FE-CAT-01`, `FE-CAT-02`, `FE-CAT-03` | Browse/search beyond the first page, open a direct detail URL, navigate back/forward, and handle empty, retired, broken-image and network cases. Public views reveal no retired product; search uses literal names/SKUs. M8. |
| `FE-ACCOUNT-01`, `FE-ACCOUNT-02` | Save profile edits and address create/edit/delete/optional-field clearing, reload and deny another customer's address ID. Name editing is verified in M9 task 1; addresses are task 7, with snapshot cross-check in M10. |
| `FE-SEC-01`–`04` | Current-password-verified replacement; initial/legacy email verification; verified email change with duplicate/concurrent handling and notifications; non-disclosing recovery with expired/single-use links and session revocation. Design in M9 task 2, implement/test tasks 3–6 and include accessibility/regressions in task 10. |
| `FE-CART-01`, `FE-CART-02`, `FE-CART-03` | Guest signs in before a deliberate add; repeated intentional adds sum, replacement sets quantity, removal/clear persist and badge follows server state. Retired/unpriced lines remain removable, incomplete estimates are labelled and ambiguous writes are not replayed. M9. |
| `FE-CHECKOUT-01`, `FE-CHECKOUT-02` | Select owned address and simulation scenario, double-click submit and observe one original intent; accepted/rejected/otherwise returned state is displayed correctly. M10. |
| `FE-CHECKOUT-03`, `FE-CHECKOUT-04` | Interrupt/lose a response, reload or change users and resolve retained intent safely; show 202/503 and specific stock/cart/address conflicts without a new automatic key, false rejection or browser recovery. M10. |
| `FE-ORDER-01`, `FE-ORDER-02`, `FE-ORDER-03` | Paginate owned orders, directly reload historical snapshots/payment status, deny foreign IDs and cancel only when allowed. Repeated/uncertain cancellation targets the original order; claimed orders cannot be force-cancelled. M10. |
| `FE-ADMIN-01`, `FE-ADMIN-02`, `FE-ADMIN-03`, `FE-ADMIN-04` | Deny customer/direct API access, then as admin create with zero stock, edit, retire/reload/reactivate and adjust inventory. Current role changes and reservation-floor/SKU conflicts remain authoritative. M11. |
| `FE-UX-01`, `FE-UX-02`, `FE-UX-03` | Across every family, verify 360/1280px layout, keyboard/focus/forms, loading/empty/failure states, direct URLs/back/reload and no credentials/private payloads in storage/logs. Begin M7; consolidate functional regressions in M11 and repeat final visual/accessibility review after the M12 polish. |

Design alone is not execution proof. M6 verifies search/admin APIs and reusable fixtures; M7 verifies direct-CORS/browser auth. M10 review/submission/recovery, owned order management/cancellation and bounded observation pass [combined acceptance](TEST_PLAN.md#milestone-10-acceptance), including 360/1280px keyboard/focus/contrast/layout and minimal metadata privacy. The saved-order details link reuses checkout action styling for the 44px target. Administration/functional UX consolidation is accepted in M11; M12 owns shared visual/CSS refinement and post-polish accessibility/regressions. Final built-SPA direct navigation with the Go server remains M14.
