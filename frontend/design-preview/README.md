# M13 interactive design preview

Task 1's isolated React preview implements the approved [visual specification](../FRONTEND_UI_DESIGN.md) using Tailwind 4.3.3, project-owned shadcn compositions and synthetic public fixture images. It supersedes the earlier plain-HTML proposal. [Design acceptance](../../docs/frontend/M13_DESIGN_ACCEPTANCE.md) records checked layouts, decisions and limits.

From `frontend/`, using the repository's installed Node/npm:

```powershell
npm run design:dev
```

Open `http://localhost:5174`. The strict port intentionally differs from the production development server's 5173. Stop this preview before changing its sources/configuration or running its browser checks. The hash routes are preview navigation only; production routes are unchanged.

- **Design review controls** select Guest, Customer or Administrator and loading/empty/error/long/missing-image/unknown-estimate/pending/uncertain states. Populate sample cart or Show pending sample order supplies review data.
- Try catalog → Quick view → Add → full cart quantity Select/More… → checkout → explicit accept/reject choice → Review → Place simulated order → owned sample order.
- At ≥1920px the cart rail sits in the outside margin near the screen edge, keeping the same centered four-card catalog with the rail open or closed. Below 1920px Cart opens an on-demand Sheet so the catalog never shrinks to accommodate it.
- Switch to Customer for account/security, addresses and saved/inline checkout shipping. Home is a placeholder, not a submitted label. Administrator exposes product search/details/create/edit/inventory layouts.
- Recovery controls demonstrate blocking alerts, deliberate retirement, retained known-order refresh and original-choice Resume. They do not implement or verify persistence, idempotency, locks or transaction recovery.

All data is in React memory. Refresh resets it. There are **no API requests, backend writes, real authentication, real orders/payments/mail, tokens, browser-storage writes, timers for order polling or guest persistence**. Do not enter real credentials or personal information. Identity controls simulate presentation, never grant application access. Local simulated success is design evidence only.

## Components and isolation

`ui.tsx` adapts the official shadcn `new-york-v4` Card, Alert, Badge, Skeleton, Separator, Dialog, Sheet, Select and Radio Group patterns reviewed through the installed CLI/MCP. The existing application Button/Input are reused. Dialog/Sheet, Select and Radio Group use individual pinned Radix primitives for keyboard/focus behavior; these are preview-only dev dependencies. Registry adaptations use the project's `tw:` prefix, semantic mint tokens, text close controls and no Preflight. The right rail is a semantic Sidebar composition, without the generated Sidebar package's unused provider/tooltip/icon collection. Production adoption remains Tasks 7–10.

The upstream [MIT notice](../src/shared/ui/primitives/SHADCN_LICENSE.md) applies to these adaptations. No remote font/image dependency is added: the local SVG fixture art and system sans-serif fallback are used because no approved Geist font asset is installed.

`vite.design.config.ts` builds only this entry into ignored `design-preview-dist/`; production Vite/Tailwind entries do not import/scan the preview. TypeScript also checks the preview. Search reuses existing `normalizeProductSearch`, while preview catalog/admin routing stays separate.

## Verification

```powershell
npm run design:build
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path '../.cache/playwright').Path
npm run design:check
```

The native Playwright runner owns its strict-port Vite process, uses one cached Chromium worker and zero retries, and stops the server afterwards. It does not start Go/PostgreSQL. It rejects nonlocal/API/non-GET requests and checks no localStorage/sessionStorage writes. Synthetic screenshots go to `.cache/milestone13/task1-frames/` at the repository root; selected previews are retained in [documentation](../../docs/frontend/prototypes/m13-react/).

If 5174 is in use, set `ECOM_DESIGN_PORT=5175` in the test command's environment. Only localhost ports 1024–65535 are accepted; the runner still owns a strict server and never reuses or stops another preview. The default remains 5174. Geometry checks compare card document positions/widths before and after cart opening, including 1919/1920/2560px.

Production checks remain `npm test` and `npm run build`. The preview is not mounted in the application or included in its browser acceptance count. Full real guest/admin/recovery implementation and acceptance remain M13 Tasks 3–11.
