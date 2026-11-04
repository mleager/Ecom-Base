# Frontend UI Design Specification

**Project:** Commerce Lab — E-Commerce Portfolio Application  
**Stack:** Vite, React, TypeScript, Tailwind CSS (v4.3.3), shadcn/ui (v4.23.0)
**Purpose:** Approved UI/UX redesign specification and implementation handoff for Codex.  
**Scope:** Nine design sections, cross-cutting behavior, backend dependencies, and acceptance criteria.  
**Alignment:** Reconciled against the approved 2026-11-02 `SHOPPING_EXPERIENCE.md` (Milestone 13 target), plus the earlier frontend routes/interaction specification. This is a **target specification**, not a claim that the features are implemented.

**Latest decisions (2026-11-02):** retain both explicit simulator outcomes; keep free-text labels with a Home placeholder; use shared catalog/admin search presentation with distinct server contexts; show current-cart-only checkout with safe contextual recovery/order-details handoff; defer mini-cart quantity editing. The recommended initial plan uses page-local counts, Add-one controls and full-cart quantity editing while preserving existing stock/reservation rules.

### Document authority and precedence

- **This document** is authoritative for the newly approved visual palette (mint, not earlier lime), page-specific presentation, and the nine reviewed UI changes.
- **`../docs/frontend/SHOPPING_EXPERIENCE.md`** is authoritative for M13 functional shopping policy: guest principals/carts, direct guest shipping, selectable deterministic payment simulation, sign-in transitions, and required application-wide component coverage. The **explicit product-card hover exception** below supersedes its earlier supplementary-hover-preview proposal; the visible Quick View entry point remains required.
- **Existing frontend routes/interaction design, `API_INTEGRATION.md`, checkout recovery design, and backend/OpenAPI specifications** retain authority over implemented routing, security, owner isolation, mutation/recovery behavior, request budgets, stock, and idempotency unless an approved M13 functional migration deliberately revises them.
- **`TOOLING.md`, `IMPLEMENTATION_SEQUENCE.md`, and `TEST_PLAN.md`** govern installed versions, migration milestones, and verification. Do not infer implementation completion from a proposal or this document. Where source specifications still disagree, implement no unsafe assumption: record and resolve the inconsistency before changing the affected behavior.

### Task 1 design handoff

The isolated React/Tailwind/shadcn preview defines the approved visual direction as of 2026-11-02. Tasks 1–5 are complete, including guest checkout and recovery with confirmed mailbox delivery. Tasks 6–11 own frontend lifecycle and production visual integration. [Preview](design-preview/README.md) · [Design acceptance](../docs/frontend/M13_DESIGN_ACCEPTANCE.md)

## Implementation Principles

- Deliver a modern, restrained, responsive **dark-mode storefront**; favor clarity and feedback over decorative animation.
- Reuse the installed Tailwind/shadcn/ui setup, existing routing, state management, and API integrations. Do not introduce another component library merely for styling.
- **Preserve existing application behavior, API contracts, authorization, order integrity, inventory rules, and checkout idempotency/recovery** except where this document explicitly calls for a functional change.
- Separate styling-only changes from backend-dependent features. Never simulate successful guest cart/checkout behavior using an unsupported backend.
- Use accessible link semantics for navigation and buttons for actions; preserve keyboard navigation, visible focus, validation, and reduced-motion support.
- Treat this specification as the target UX, not a replacement for technical source-of-truth documents. Inspect actual code, M13 scope, and checkout design before changing behavior. If a visual requirement conflicts with a security/reliability invariant, preserve the invariant and document the conflict.

---

## Picture References

All referenced pictures and screenshots are located at `../docs/frontend/references/`

--- 

## 1. Global Styling

### Visual direction and tokens

Use charcoal-on-black surfaces with a **soft mint-green primary accent**, blue informational links, and muted semantic status colors. Protech (`dark-mode-ui-blog-banner.png`) informs the navigation aesthetic; Rhapsody (`dark-mode-ui-catalog-example.jpg`) informs background tones and accent direction—not its typography or layout.

| Semantic token | Color | Primary use |
|---|---|---|
| `background` | `#0D0F11` | App background |
| `surface` / `card` | `#171A1E` | Cards and panels |
| `surface-elevated` | `#202429` | Menus, dialogs, hover surfaces |
| `border` | `#30363D` | **Decorative** dividers and low-emphasis card edges only |
| `control-border` | `#73808C` | Meaningful input/control outlines requiring clear visibility |
| `focus` / `ring` | `#B5D9FF` | Visible keyboard focus, distinct from selection and hover |
| `primary` | `#8CC9B7` | Filled primary actions, selected states |
| `primary-hover` | `#A5D9C8` | Primary hover |
| `primary-pressed` | `#6EB09C` | Primary pressed |
| `primary-foreground` | `#101B18` | Text/icons on primary |
| `foreground` | `#F3F5F6` | Main text and headings |
| `muted-foreground` | `#AAB3BD` | Labels, secondary details |
| `link` | `#91BEF2` | Informational links |
| `success` | `#80D4A5` | Stock available, success |
| `warning` | `#E5BF78` | Cautions |
| `destructive` | `#ED9393` | Errors/destructive actions |

- Replace all existing neon/lime primary controls with mint-green; retain clearly identifiable blue links and green stock indicators. **This intentionally supersedes the legacy M12 and the M13 proposal’s “lime” visual wording**, without changing M13 business behavior.
- Use a nearly black page background, with an *optional very subtle* charcoal gradient in main content. Distinguish layers mainly with surface contrast; borders and shadows should remain restrained. Avoid glows and strong gradients.
- Implement semantic CSS variables compatible with the project's installed Tailwind/shadcn version (`background`, `foreground`, `card`, `primary`, `ring`, etc.); add named custom tokens where needed. Avoid hard-coded component-level hex values.
- Check actual rendered contrast: normal text ≥4.5:1 and meaningful controls/focus indicators ≥3:1 against adjacent surfaces. Use `control-border` rather than the decorative border token for form boundaries. Distinct, visible focus normally uses an ~3px outline and offset; validate hover, active, disabled and autofill states. Tune tokens if testing shows failures.

### Typography, geometry, and motion

- **Font:** Geist with system sans-serif fallback (no runtime remote-font dependency; use locally available/approved assets or fall back gracefully). Suggested scale: page heading **32px/600–700**; section **24px/600**; card heading **16–18px/600**; body **14–16px/400**; navigation/buttons **14px/500–600**; metadata **13–14px/400**; prices **20–24px/600–700**. Scale down large headings on narrow screens.
- **Radius:** product cards `16px`; other cards `12–16px`; buttons `10–12px`; inputs `10px`; dialogs `16px`; menus `10–12px`; badges/navigation pills fully rounded. Centralize this scale.
- **Spacing:** desktop horizontal gutters `24–32px`, mobile `16px`; sections `32–40px` apart; card padding `16–24px`; form-field spacing `16px`. Main content max-width approximately `1280px` unless a page specifies a narrower column.
- **Controls:** button visual height approximately `44px`, interactive targets at least `44px`; clear `focus-visible` styling. Primary buttons: mint background/dark text; secondary navigation: outline or muted surface; destructive actions: semantic destructive treatment.
- **Motion:** subtle `150–200ms` transitions for color, border, and elevation; respect `prefers-reduced-motion`. No large scaling, elaborate page transitions, or distracting shadows.
- **Shared UI states:** use consistent loading/skeleton, disabled, success, error, empty, toast, and contextual retry styling. A transient toast must not replace persistent uncertain-write guidance. Remove normal reload buttons only where an explicit **reconciliation/readback** action remains available after ambiguous writes.

---

### M13 component-migration constraints

- Tailwind/shadcn migration is **application-wide**, including product details, account security, sign-in/registration, recovery-email/reset pages, orders, Admin Create Product, inventory adjustment and their states. The nine sections specify requested changes, **not** the complete page inventory.
- Reuse the current Tailwind `tw:` prefix/no-Preflight coexistence and project-owned primitives; adopt shadcn components incrementally. Do not install unrelated routing, form or state frameworks, and keep minimal token-link pages outside shopping chrome.
- Keep the current semantic/ARIA/focus, session boundaries, request budget, URL/history restoration and ownership invariants described in the original frontend interaction document.

---

## 2. Header and Main Catalog Page

**References:** `current-catalog-page-signed-in.png`, `dark-mode-ui-blog-banner.png`, `amazon-sidebar-cart.png`.

### Header

- Create a compact, sticky charcoal header inspired by the **structure and polish** of Protech, **not its accent colors**. Subtle bottom border/shadow; rounded navigation controls; Lucide icons when useful.
- Desktop arrangement: **Commerce Lab brand left**, **product name/SKU search center**, **navigation, cart, account actions right**. Preserve search functionality. Tablet uses compact navigation; mobile uses collapsible navigation and appropriately sized search.
- Keep header/body alignment consistent for signed-in and guest states. Authentication-specific items are defined in Section 3.

### Catalog

- Replace the repeated large “Commerce Lab” content banner with a compact introduction; retain the **number of products on the current page** and existing supported result range (for example, “Products 21–40”). No total-dataset count, total-page count or count endpoint is added.
- Responsive product grid: target **4 columns desktop**, **2–3 tablet**, **1–2 mobile**, adjusted to usable width (including an open mini-cart). Keep consistent image aspect ratios, card heights, gaps, and spacing.
- Product cards show **image, name, SKU, price, stock availability, and Add to Cart**. **Do not add product descriptions or truncated descriptions to cards**; descriptions belong on the product details page.
- The whole card should provide navigation to product details, while **Add to Cart remains a separate actionable control**. Do not nest buttons inside anchor elements or create overlapping inaccessible click targets.
- Card hover/focus: roughly `translateY(-3px)`, slightly stronger border/shadow, ~`180ms` transition. **Do not show supplementary text or a Hover Card on hover**; this is an intentional design exception to M13’s hover-detail proposal. Provide keyboard focus equivalents and reduced-motion fallback.
- **M13 Quick View:** Preserve a distinct, visible, keyboard/touch-operable **Quick view** button as a secondary action (no description text embedded in the card). Open interactive details/purchase controls in a shadcn/ui `Dialog` on desktop or `Sheet` on narrow screens; use the same purchase controller as the detail page, bound any extra reads, support Escape/close/focus restoration and avoid viewport collisions. Card navigation, Quick view and Add to Cart must be independent interactive targets, never invalid nested controls.
- **Purchase-control plan:** catalog cards, details and Quick View use Add to Cart to add **one** item per deliberate action; repeated deliberate clicks add one each, subject to existing cart limits and pending/uncertain-write guards. When confirmed cart state is available, show “In cart: N” and access to View Cart; an unknown count stays unknown. Quantity replacement belongs on the full cart page. Preserve the single shared cart controller and supported read budgets.
- Availability is an observation. Cart additions do not reserve inventory and must not be capped by an observed stock value; server cart limits still apply, and checkout authoritatively validates/reserves stock. Show stock warnings honestly without inventing reservations or silently changing quantities.

### Mini-cart sidebar

- Inspired by Amazon's right-side mini-cart, but styled with the shared dark theme.
- **Wide desktop ≥ 1920px:** right-side shadcn/ui `Sidebar` on catalog/product browsing routes, width approximately `260–288px`, below the actual sticky-header height, independently scrollable. Keep the 280px rail 24px from the **viewport's right edge**. The catalog retains its original centered 1216px usable width and four-card row, whether the cart is open or closed; the rail occupies the outside margin, with approximately 48px separation at 1920px (allowing for native scrollbar width). Opening, closing or populating the cart must not resize, reposition or reflow product cards. Keep it off account/security, full cart, checkout, orders and administrator pages. **Below 1920px:** use an on-demand right-side `Sheet`, preserving the original responsive catalog rather than squeezing or covering it with a permanent rail. Full-cart navigation remains available. This supersedes the earlier 1280px rail breakpoint and three-column-with-cart design.
- Auto-expand desktop mini-cart on the first confirmed nonempty cart for the active verified owner in a tab's browsing lifetime; allow collapse/reopen and respect manual dismissal during that lifetime. Keep this presentation state in memory, close/reset it on identity change, and clear obsolete callbacks. A reload begins a new presentation lifetime; it does not clear the server cart or checkout intent. Hide empty mini-cart content; retain cart access in the header. On mobile, adding an item updates the badge without forcing an overlay open. Crossing a breakpoint must not force a Sheet open or steal focus. The on-demand `Sheet` also fulfills the M13 cart-drawer requirement.
- Contents: confirmed quantity-sum item count, **estimated** subtotal and pricing disclaimer, **View Cart** button, and compact items with thumbnail, name, price, **read-only quantity** and a separate Remove action. There are **no quantity Select, increment/decrement, More… or replacement controls in the sidebar/Sheet in this milestone**; quantity editing goes through View Cart. Sidebar quantity editing is deferred.
- Update from **confirmed** cart mutations, maintain consistent count/subtotal across header, sidebar, and cart page, and preserve unknown/pending/error states. Removal uses the existing shared controller, sends once and requires contextual authoritative readback if its outcome is uncertain. Never turn missing price data into a zero subtotal or cap quantities by an observed stock value.

---

## 3. Signed-In vs. Guest User

**References:** `current-catalog-page-signed-in.png`, `current-catalog-not-signed-in.png`.

- Keep the same product-card appearance regardless of authentication status. **Always show “Add to Cart”; remove “Sign in to add.”** No login redirect for adding to a supported guest cart.
- **Signed-in header:** Home, Your account, Your orders, Cart + item count, Administration *only for authorized admins*, Sign out, plus the signed-in user's name.
- **Guest header:** Home, Sign in, Create an account, **Cart + item count**. Navigation appearance follows Section 2.
- Guests must ultimately be able to add/update/remove cart items, retain them across navigation/reloads, and complete checkout without registering. They enter **contact email and required US shipping directly within checkout**; neither account registration nor a saved address is required. This requires a secure backend-owned guest-cart/session design; do not treat a raw client-supplied cart ID as proof of ownership.
- Define guest session expiry/restoration and sign-in/sign-out transitions in the backend-dependent workstream. When both guest and authenticated carts contain items on sign-in, offer an **explicit choice**; no silent merge or transfer of unresolved checkout ownership. Preserve authenticated-cart behavior and authorization.

### Required implementation split

1. **Frontend UI redesign:** theme, navigation, product cards, mini-cart, and guest-visible controls. Keep unsupported guest mutations disabled/feature-gated until backend support exists; do not misrepresent functionality.
2. **Guest shopping and checkout:** secure backend guest cart ownership/persistence and APIs, guest order access, checkout reliability integration, then activation of frontend guest flows.

Do not release a fully enabled guest checkout flow before its server-side protections and tests are in place.

---

## 4. Account and Shipping Address Pages

**References:** `current-account-page.png`, `current-shipping-addresses.png`, `current-add-shipping-address.png`.

### Account

- Replace **Account security** and **Shipping addresses** text links with secondary/outline shadcn `Button`-styled navigation links (`asChild` with the existing router link).
- Remove **Reload profile** and its explanatory text from the normal view; retain automatic data synchronization and contextual retry if loading fails. **After an uncertain profile save**, block duplicate mutation and offer an explicit recheck/reload of authoritative server values, with unsaved-edit warning, as required by the existing profile contract.
- Keep profile summary, name editing, existing validation, authorization, and Save changes. Save uses mint primary; disable while unchanged or saving.

### Shipping addresses

- Remove **Reload addresses** from the normal view. Keep **Add shipping address** (mint primary), **Edit address**, and **Delete address** actions. Retain delete confirmation, empty/error/loading states, and refresh after **confirmed** changes. After an uncertain add/edit/delete, require deliberate authoritative reread/reconciliation before another potentially duplicate write; show this action contextually.
- Preserve the established address cards and ownership restrictions while updating surface/border/spacing styles.

### Add/edit shipping address

- Keep **Address label** as an optional free-text shadcn Input. For a blank create/edit field, show **Home** as muted, readable placeholder text. This is an example, not a stored default: an untouched empty field does not submit Home. Preserve an existing saved label on edit and its existing optional-field clearing semantics.
- Preserve recipient, address lines, city, state/DC, ZIP, country restrictions, and existing validation. Use the existing create/save flow and mint-green primary button.
- Existing backend text/length validation remains authoritative. Fixed label choices, enums, database constraints and label-data migrations are deferred; no new label restriction is part of M13.

---

## 5. Cart Page

**References:** `current-cart-layout.png`, `dark-mode-ui-cart.jpg`.

- Use a **centered, single-column layout** (max-width approximately `900px`). Show compact horizontal product cards stacked vertically; **cart summary below the list**, not in a side column. Maintain responsive stacking for narrow screens.
- Each row: image, linked product name, SKU, availability, unit price, estimated line total, quantity selector, remove action. Keep the layout compact with rounded charcoal surfaces and subtle dividers.
- Remove free-text quantity editing, **Set quantity**, and **Add quantity** buttons. Replace with shadcn/ui **Select** options **1–10** plus **More…** (opens numeric input in dialog/popover for allowed quantities up to **10,000**). Show values over 10 correctly. A product newly added to an empty line starts at quantity **1**; preserve established behavior on repeated adds.
- Quantity selection issues **one replacement mutation per deliberate choice**: show a pending state, serialize/coordinate overlapping writes and honor server cart quantity/capacity/version validation. Cart quantities do not reserve stock; checkout validates availability. For a **definitive rejection**, restore the last confirmed value and explain it; for a **timeout, lost reply, 500/503 or other uncertain write**, do **not** assume failure, revert as if authoritative, or replay. Preserve the uncertain state and require explicit server readback before another write. Sync header badge and mini-cart only from confirmed state.
- Keep item count, **estimated** subtotal, pricing/inventory disclaimer, mint **Proceed to checkout review**, and destructive **Clear cart** in the summary.
- Remove always-visible **Retry product details** and **Reload cart**; keep automatic refresh after confirmed operations plus **contextual read retry/reconciliation** on failed reads or uncertain writes. Preserve **Continue shopping**. Keep the existing bounded product-enrichment/read budget and removable unknown/unavailable lines; never present unknown prices as zero.
- Empty cart: concise message and Continue shopping button; hide checkout submission/summary actions.
- **Do not add** reference-only features such as discounts, tax estimates, shipping quotes, or recommendation carousels without corresponding existing support.

---

## 6. Review Checkout Page

**References:** `current-checkout-page.png`, `current-checkout-pt1.png`, `current-checkout-pt2.png`.

### Default entry state

- On entry, automatically load/show **only the current cart's items and checkout form**—no Review a new checkout click and no previous-order panels. Loading this form sends reads only; shipping/payment choice validation through **Review order** and deliberate **Place simulated order** remain separate steps.
- Remove from the *normal checkout screen*: historical **Saved order status**, **Recheck saved checkout**, previous completed order references, **Review a new checkout**, and bottom **Your orders** / **Review cart** links. Order history lives at **Your orders** in the header.
- Show current cart items (image, name, SKU, quantity, unit price, stock, line estimate) and an **estimated** subtotal/disclaimer. No total becomes authoritative until confirmed by the server.
- **Signed-in shoppers:** select from owned saved-address **cards** with accessible exclusive selection, plus **Add a shipping address** and **Manage shipping addresses** styled as secondary/outline navigation buttons. Support contextual inline address creation where required by M13; after a confirmed save, return/select the new owned address and refresh review data. Failed/uncertain saves must not create duplicate addresses or silently change selection.
- **Guests:** show required contact **email** and direct US shipping fields (recipient, address line 1, city, state/DC and ZIP; optional address line 2). **No owned-address selector, sign-in, or saved-address requirement.** The server snapshots confirmed shipping at order creation.
- Show a concise notice: payment is **simulated**, no real payment information is collected and no real charge is made. Keep a clearly labelled **Payment simulation** Radio Group with **Simulate payment acceptance** and **Simulate payment rejection**; require an explicit selection and show it in the review summary. Preserve the existing deterministic `accept`/`reject` contract for both authenticated and future guest purchases. Stock, validation, authorization, network and other failures remain possible.
- Apply the Section 1 dark theme and mint primary actions.

### Order handoff and status destination

- After persisting a validated authoritative order ID and establishing the existing durable known-order handoff, navigate to the **existing owned order-details/status route**. Confirmation, order items, authoritative total, payment outcome and pending observation belong there; they do not become a previous-order panel in checkout. If response/handoff is uncertain, retain the original intent and show contextual recovery guidance without claiming placement succeeded or failed.
- On the order-details/status page, **Check Status** performs one **bounded logical observation** and displays its authoritative result. Preserve the existing 10-second budget, permitted GET authentication renewal/payment fallback and M10 automatic read/deadline/attempt limits. It must not POST checkout or restart an observation loop. Render `payment_failed` / payment `failed` as **Simulated payment rejected**; `rejected` is display wording, not a new API order status.
- Revisiting checkout for a *new cart* should show the new cart review, **not a prior completed order**.

### Non-negotiable recovery safeguards

- **Never drop or silently replace an unresolved checkout intent to satisfy the new UI.** If an earlier attempt might have committed, show a compact contextual recovery Alert with no previous-order item list, total or status panel. Block a conflicting submission and explain that Resume uses the original cart/address/payment request and may submit it if no order committed. Keep explicit original-request Resume/recheck or navigation to owned orders as supported by the recovery contract.
- Preserve intent across timeouts/network failures, HTTP 500, malformed/unexpected responses, and other non-definitive outcomes; authentication failures do not prove that an earlier submission did not commit.
- Preserve existing idempotency keys, exact original request body including the selected scenario, durable intent/known-order handoff, bounded observation, same-owner cross-tab coordination, and backend checkout integrity. Never change an unresolved `reject` request to `accept`, retire it on local expiry, or generate a replacement key to bypass uncertainty. Both new and historical accepted/rejected outcomes remain supported. UI cleanup must not bypass recovery gates or create duplicate orders.
- A verified pre-commit rejection still requires deliberate matching-record retirement before a new reviewed intent. A known order requires durable handoff and a successful fresh cart read before a subsequent deliberate review/submission; retain the locator and block a new checkout if refresh fails. Suppress old order presentation without deleting recovery metadata.
- T1 consumes/clears the cart before payment simulation. A simulated rejection records payment failure and releases reservations; it does **not** automatically refill the cart. Explain this on the order page. A subsequent purchase requires deliberate cart preparation, fresh review and a new intent; never modify/replay the rejected order with another scenario.
- Empty cart: present an empty-cart message/Continue shopping, not historical order details. Unresolved checkout recovery can still take precedence where safety requires.
- Guest checkout follows the same guarantees after the backend workstream is implemented.

---

## 7. Admin Main Page

**Reference:** `current-admin-main-page.png`.

- Center **Administration** heading, “Your current account has administrator access.” description, and **Browse products** primary button within a restrained approximately `600–700px`-wide content area.
- Remove the heavy outline surrounding the heading; use standard heading typography and spacing.
- Remove redundant **Your account** and **Return home** page links (already in header).
- Keep the Browse products destination, admin-only authorization, and application-level notices (e.g., email verification). Use the shared mint/dark theme. No backend changes required.

---

## 8. Admin View Products Page

**References:** `current-admin-view-inventory.png`, `current-admin-view-inventory-pt2.png`.

- Preserve the existing products table and **Create product** mint primary action. Remove the heavy heading outline and apply the global surface, spacing, and typography system.
- Reuse the catalog's shared **search-bar presentation and normalization/validation** with placeholder **“Search by product name or SKU”**. Provide an admin-scoped submit handler using the existing administrator list endpoint and server role checks. Match name/SKU case-insensitively across the **full eligible dataset**, together with Product status and Products per page (default **20**). Apply search/status/page-size together with **Apply filters**, reset offset to zero on submission, and retain the query in URL/history and detail return links. Give the admin search a distinct accessible name from the global catalog search; sharing presentation does not share the catalog route handler or endpoint.
- Replace the **Next**-only control with shadcn/ui **Pagination**: Previous, Next, current page indicator, and page numbers **only if supported**. Preserve filters, ordering, and loading states during navigation. Disable unavailable directions.
- **Current admin API uses URL-owned `offset`/`limit` pagination**, not cursors: preserve validated `is_active` (`true`/`false` or omitted), `limit` (20/50/100 options, maximum 100) and `offset`; maintain the existing product ordering and `adminQuery.ts` allowlist. Show Previous/Next and a derived current-page indicator. **Do not invent total pages or arbitrary numbered page links** without a total/count contract; an empty later page must still allow Previous. Never fetch the entire dataset merely to produce page links.
- Table columns remain **Product, SKU, Status, Unit price, Available quantity**. Product name links to admin product details; align numeric columns right; apply subtle row hover, status colors, and mobile horizontal scrolling. Preserve the disclaimer that availability is an observation, not a reservation.
- Remove **Reload products**, **Administration home**, and **Return to storefront** from the ordinary page; retain contextual loading-error retry and header navigation.
- Backend admin search expansion **is required**: the current admin query allowlist rejects `q`. Reuse the public search's bounded literal substring rules (trimmed valid Unicode, at most 200 code points, escaped LIKE metacharacters) while preserving administrator status filtering and ordering; do not filter only the current page.

---

## 9. Admin Product Details and Editing

**Reference:** `current-admin-product-details.png`. This section covers **product details and navigation to edit/inventory workflows**, not the Create Product form.

- Preserve the **Product information** panel: name, SKU, status, unit price, product reference, description, image URL. Keep two-column desktop layout and stack on smaller screens.
- Preserve **Inventory** with three clear cards: **On hand**, **Reserved**, **Available**, plus the note that availability excludes reservations and may change after refresh.
- Replace **Edit product** text link with a **secondary/outline button** pointing to the existing edit flow.
- Rename **View inventory** to **Adjust inventory quantity**, display as the **mint primary button**, and route to existing inventory adjustment functionality (increase/decrease stock). **Do not add inventory quantity controls to product creation or ordinary product editing.**
- Keep **Back to products** as a secondary navigation button. Remove redundant **Administration home**.
- Replace prominent **Reload product and inventory** with a compact secondary **Refresh** button that rereads both product and inventory; preserve loading/error states. This is an intentional exception to the general removal of routine reload controls because inventory observations may need explicit refresh.
- Maintain admin authorization and existing adjustment/stock validation. No new backend functionality required for these visual/navigation changes.

---

## Backend-Dependent Changes (Separate Workstreams)

This table distinguishes actual backend dependencies from retained contracts and deferred changes. Design and verify required backend work before enabling dependent frontend behavior; styling alone cannot supply it.

| Workstream | Needed change | Important constraints |
|---|---|---|
| **A. Guest identity, carts, shipping and order access (`GAP-08`)** | Server-recognized guest principal with opaque **protected cookie**, server-persisted cart, guest cart APIs, direct checkout contact/US shipping snapshot, safe guest order/status access, and mailbox-proof recovery without account registration | Specify TTL/revocation, CSRF/Origin/abuse limits, resource cleanup, cross-tab locks/broadcast, credential loss, session rotation and ownership, secure one-time email proofs, and explicit guest/auth cart choice. **No email/order ID as authorization, synthetic registered users, or contact/address secrets in localStorage.** Update Go/PostgreSQL/OpenAPI before enabling guest UI. |
| **B. Selectable deterministic payment simulation** | Preserve the existing `accept` and `reject` scenarios, explicit customer choice and review summary; no new payment endpoint, provider or payment-policy migration | No real payment details/charges. Persist the selected scenario in the immutable original request; same-key/body recovery returns authoritative state without repeating settlement. Acceptance consumes reservations; rejection records `payment_failed` / payment `failed` and releases reservations. Cart clearing from T1 is not undone. Guest contracts extend the same guarantees. |
| **C. Address labels — presets deferred** | Keep optional free-text labels and existing text/length validation; the UI shows Home as a placeholder for a blank field | No enum, database constraint or label-data migration now. Preserve saved custom labels, optional-field clearing, ownership and US validation. Home is not silently submitted. Guest shipping does not require a label/address-book row. |
| **D. Admin product search** | Extend the existing admin list operation with bounded literal name/SKU `q` search | Current admin frontend/backend allowlists lack `q`. Update parser, service, SQL/sqlc, OpenAPI, typed clients/URL state, fixtures and tests. Combine search with status/limit/offset under current admin authorization; reuse catalog search presentation and validation. No new count endpoint or fetch-all behavior. |
| **E. Checkout UI/recovery integration** | Current-cart-first review, contextual recovery, bounded status read and inline signed-in shipping creation | Preserve persistence/coordination, original-key/body recovery, known-order handoff, observation budgets and uncertainty gates. Update contracts only through approved M13 design, never through cosmetic UI changes. |

The backend provides guest sessions, carts, original checkout preparation, orders and scoped mailbox recovery in API 1.7.0. Task 6 owns frontend lifecycle and Task 7 owns shared search presentation. Workstream B preserves both simulator scenarios. Workstream E preserves the original-key recovery guarantees. [Guest commerce design](../docs/backend/GUEST_COMMERCE_DESIGN.md)

---

## Recommended Codex Implementation Order

Follow the approved M13 **11-task implementation sequence** in `IMPLEMENTATION_SEQUENCE.md`; the ordering below is a dependency view, not a replacement for milestone owners:

1. **Audit/design gate:** Inspect current routes, `TOOLING.md` installed versions/configuration, `SHOPPING_EXPERIENCE.md`, admin `offset` queries, API/checkout recovery contracts and task 3's unresolved guest/payment policy details.
2. **Incremental foundation:** Extend the existing Tailwind **4.3.3** / shadcn CLI **4.23.0** setup and project primitives. Respect the current `tw:` prefix/no-Preflight coexistence, preserve current build/toolchain pins, and remove old CSS only after its callers migrate and regressions pass.
3. **Backend design and implementation:** Specify/implement server-owned guests, guest shipping/order recovery and admin product search. Preserve both payment scenarios and validate security, migrations and original-intent recovery before activating guest checkout. Keep address labels free-text; presets are deferred.
4. **Storefront:** Theme, responsive header/search, catalog cards, accessible Quick View, right mini-cart and role-aware navigation; feature-gate until actual guest APIs work.
5. **Customer flows:** Account/address UI, quantity Select and cart, signed-in/guest shipping, current-cart-first checkout, safe status/recovery and order history. Preserve existing interaction controllers and read/write budgets.
6. **Administration:** Sections 7–9; existing authorization, `offset` pagination, admin product search and inventory adjustments.
7. **Whole-application migration and QA:** Include product detail, orders, authentication/security/recovery, Create Product and all loading/error/empty/uncertain states—not only the nine page sections. Verify browser widths **360/480/768/1024/1280px**, keyboard/touch/focus, real Go/PostgreSQL cases, type/build/unit suites, M13 regression gates; M14 packaging remains blocked until acceptance.

Prefer focused commits/PRs (theme, storefront, account/cart, checkout, admin, backend dependencies), rather than mixing unrelated visual and transactional changes.

## Acceptance Criteria

- [ ] Theme uses the specified charcoal/mint/blue token system throughout; no legacy neon primary buttons remain.
- [ ] Header/search/navigation remain usable at desktop, tablet, and mobile sizes, with correct role-dependent links.
- [ ] Product cards are keyboard-accessible and navigate correctly; Add to Cart and visible Quick View work independently; **no product description or supplementary hover text appears on cards**. Dialog/Sheet quick view restores focus, supports Escape and uses the shared purchase logic.
- [ ] Right mini-cart/Sheet matches confirmed state, uses read-only quantities with View Cart/Remove, respects dismissal/identity/breakpoint rules, and never obscures desktop browsing content. Sidebar quantity editing remains deferred.
- [ ] Guest-facing Add to Cart works only with verified guest ownership/persistence support; guest checkout collects direct contact email/US shipping without saved-address requirements, and guest order/status retrieval is authorization-safe.
- [ ] Account/address pages use specified buttons and contextual reconciliation. Labels remain optional free-text with a readable Home placeholder; saved labels and clearing behavior are preserved with no enum/constraint migration.
- [ ] Cart uses quantity Select + More, sends one deliberate replacement, supports the full allowed range and handles **definitive vs uncertain mutations differently**; header/drawer/counts never treat unknown data as confirmed.
- [ ] Checkout defaults to the **current cart**; prior completed orders do not occupy the normal review screen; historical orders remain accessible via header.
- [ ] Checkout retains explicit acceptance/rejection simulation and immutable original intents. Normal checkout contains only current-cart review/form data; previous-order panels are absent, contextual recovery still blocks unsafe writes, and durable order handoff leads to owned details/status. Check Status performs bounded readback there without checkout replay. Rejection never silently refills the cart or changes the original scenario.
- [ ] Admin dashboard is centered; admin products search and **offset/limit-based** pagination work with server semantics; details page has Edit product and Adjust inventory quantity buttons.
- [ ] All page families—not only Sections 1–9—use the coherent theme and preserve loading/empty/error/pending/uncertain states, authorization, keyboard/touch accessibility, focus, responsive reflow and business invariants.

## Out of Scope Unless Separately Approved

- New discount, tax, shipping-rate, wishlist, rating, recommendation, or product-variant features shown only in reference images.
- New product-description previews on catalog cards.
- Replacing current checkout/idempotency architecture, inventory logic, or existing navigation destinations without a separately approved functional specification.
- Moving inventory adjustment into product creation.
- Fixed address-label presets/constraints, quantity editing in the mini-cart, and total-dataset/count-based pagination contracts. Full-cart quantity editing and existing page-local counts remain in scope.

