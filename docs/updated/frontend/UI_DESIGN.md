# UI design

The current visual and interaction design (M13 "mint" revision). It merges `docs/frontend/UI_DESIGN.md`, `frontend/FRONTEND_UI_DESIGN.md`, `SHOPPING_EXPERIENCE.md`, `VISUAL_ACCEPTANCE.md` and `M13_DESIGN_ACCEPTANCE.md`. Reference images are in [docs/frontend/references](../../frontend/references).

**Rule of precedence:** if a visual requirement conflicts with a security or reliability rule, the rule wins.

## Visual system

Dark storefront, charcoal on near-black, with a soft mint accent. The tokens live in `src/styles.css` and are mapped into Tailwind with the `tw:` prefix.

| Token | Color | Use |
|---|---|---|
| `background` | `#0D0F11` | Page |
| `surface` / `card` | `#171A1E` | Cards, panels |
| `surface-elevated` | `#202429` | Menus, dialogs |
| `border` | `#30363D` | Decorative dividers only |
| `control-border` | `#73808C` | Input and control outlines |
| `focus` / `ring` | `#B5D9FF` | Keyboard focus |
| `primary` / hover / pressed | `#8CC9B7` / `#A5D9C8` / `#6EB09C` | Primary actions, selection |
| `primary-foreground` | `#101B18` | Text on primary |
| `foreground` / `muted-foreground` | `#F3F5F6` / `#AAB3BD` | Text |
| `link` | `#91BEF2` | Informational links |
| `success` / `warning` / `destructive` | `#80D4A5` / `#E5BF78` / `#ED9393` | Status |

- **Type:** system sans-serif (no approved Geist asset, no remote fonts). Page heading 32px, section 24px, body 14–16px, prices 20–24px.
- **Shape:** product cards 16px radius, buttons 10–12px, inputs 10px; badges are pills.
- **Layout:** content max width about 1280px; gutters 16px on mobile and 24–32px on desktop.
- **Targets:** at least 44px. Focus outline about 3px with an offset.
- **Motion:** 150–200ms color and elevation transitions only; `prefers-reduced-motion` is respected.
- **Contrast:** text ≥ 4.5:1; controls and focus ≥ 3:1.

## Components

Project-owned shadcn components (`new-york-v4` adaptations) are in `src/shared/ui/primitives/`: Badge, Button, Card, Dialog (also used as a Sheet), Input, NativeSelect, Select, Separator, Textarea. Tailwind runs **without Preflight** next to the existing CSS Modules. Migrated controls opt out of the legacy element rules.

Add components with the local CLI from `frontend/` (`npx shadcn add … --dry-run` first). Review every diff, and never overwrite in bulk.

Native radios, checkboxes, tables, links and forms stay native where they already provide the right behavior.

## Page families

| Area | Design |
|---|---|
| Header | Sticky charcoal bar: brand left, search center, navigation, cart and account right. A mobile menu dialog on narrow screens. Guests see Sign in, Create account and Cart. Signed-in users see Account, Orders, Cart, Sign out and their name. Admins also see Administration. |
| Catalog | Compact introduction showing the current page range (no total). Grid: 4 columns on desktop, 2–3 on tablet, 1–2 on mobile. Cards show image, name, SKU, price, stock and **Add to Cart** (adds one). The whole card links to details; Add and **Quick view** are separate controls. Hover lifts the card about 3px with no extra text. |
| Quick View | Dialog on wide screens, Sheet below 48rem. Loads the product only when opened. Uses the same purchase controls as the detail page and returns focus on close. |
| Product detail | Image beside a purchase panel. Shows "In cart: N" when it is known. The description appears only here. |
| Mini-cart | At **≥ 1920px**, a 280px rail fixed to the viewport, outside the 4-card grid, so cards never reflow. Below that, an on-demand Sheet. Quantities are read-only, with a Remove action, an estimated subtotal and **View Cart**. |
| Cart | Line items, then the summary below them. Quantity uses a Select with **More…** for a custom number, plus a separate Remove. Unknown prices are never shown as zero. |
| Checkout | Current cart only, with no panels for earlier orders. Guests enter contact details and a US address. Signed-in users choose an owned address card or create one inline (the label shows a muted "Home" placeholder and stays optional). An explicit **accept / reject** simulation choice, then **Review order**, then a separate **Place order**. Recovery notices appear only when relevant. |
| Orders | Cards with immutable items, shipping, payment status and eligible cancellation. Guest history is paginated. |
| Account and security | Single-column forms up to 640px. Email-link pages are minimal and have no catalog header or images. |
| Admin | Shared search bar (separate URL), status filter, page size 20/50/100, semantic table, explicit confirmations for retire, reactivate and stock changes. On-hand, reserved and available counts are always labelled. |

## Interaction states

| State | Behavior |
|---|---|
| Loading | Labelled progress with a stable layout. Never a misleading zero badge. |
| Empty / not found | A contextual message and a next step. An empty list looks different from a failed request. |
| Input error | Keep input, focus the error summary, link to the field when it is known |
| Uncertain write | Persistent warning, further edits blocked, explicit reload or recheck action. A toast must never replace this guidance. |
| Success | Announced with `role=status`, without stealing focus |
| Confirmation | Inline confirm/cancel pair, or a Dialog with focus management |

## Accessibility

Semantic landmarks, one `h1`, a skip link, visible labels and keyboard operation everywhere. Route changes update the title and focus the heading. Back and forward keep the query and scroll position (up to 50 catalog positions in memory). Failed images fall back to `/fixtures/v1/unavailable.svg`.

## Accepted verification

- M12 visual acceptance covered 94 inspected frames at 5 widths.
- The M13 design preview covered 162 synthetic frames and 17–20 preview checks.
- M13 production acceptance passed 348 Chromium tests, including sampled keyboard, reflow and contrast checks.

**Limits:** these checks used Chromium only and sampled contrast. Real zoom, password managers, screen readers, other browser engines and physical devices are not certified.

## Design preview

`frontend/design-preview/` is a separate React preview with synthetic data, used for layout review. It is not part of the production build. Commands: `npm run design:dev` (port 5174), `design:build`, `design:check`.
