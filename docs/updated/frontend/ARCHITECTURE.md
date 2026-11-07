# Frontend architecture

A single-page React app in `frontend/`. It talks directly to the Go API through CORS. There is no dev proxy and no server rendering.

## Stack (exact pins)

| Package | Version |
|---|---|
| react, react-dom | 19.3.1 |
| react-router (declarative `BrowserRouter`) | 8.5.0 |
| vite, @vitejs/plugin-react | 8.3.5, 6.1.2 |
| typescript | 7.0.2 |
| tailwindcss, @tailwindcss/vite | 4.3.3 |
| shadcn CLI (dev) | 4.23.0 |
| @radix-ui/react-dialog, react-select, react-slot | 1.3.1, 2.4.1, 1.5.0 |
| cn, class-variance-authority | 0.2.6, 0.7.1 |
| vitest, jsdom, Testing Library | 5.0.5, 30.1.3, React 16.3.3 / DOM 10.4.2 / user-event 14.6.8 |
| @playwright/test | 1.64.1 |

Node 24.20.0 and npm 11.19.0 are enforced (`engine-strict`, `packageManager`). `frontend/package.json` and [toolchain.json](../../frontend/toolchain.json) must match.

There is no state, HTTP, form or icon library. Everything uses native `fetch`, React context and hooks, and native forms.

## Source layout

| Path | Owns |
|---|---|
| `src/main.tsx` | Removes token fragments before the router mounts, then mounts `BrowserRouter` |
| `src/app/` | Route table (`routes.tsx`) and the render-error boundary |
| `src/shared/api/` | `createApiClient()`, base URL validation (`config.ts`), DTO runtime guards (`contracts.ts`), guest transport, deadlines |
| `src/shared/ui/` | Store layout and header, search bar, fields, error summary, notices, async states, money; `primitives/` holds project-owned shadcn components |
| `src/shared/catalogQuery.ts` | One search and query parser shared by the form, API, paging and return paths |
| `src/features/auth/` | `SessionController`, `SessionBoundary`, `AdminBoundary`, login and signup, cross-tab coordination |
| `src/features/catalog/` | Product list, details, Quick View, pagination |
| `src/features/account/` | Profile, security, email verification and change, addresses |
| `src/features/cart/` | `CartController`, full cart, mini-cart, product enrichment, guest commerce, commerce locks |
| `src/features/checkout/` | Review, placement, recovery records and coordination, guest checkout |
| `src/features/orders/` | History, details, bounded observation, cancellation |
| `src/features/admin/` | Product list and search, details, create, edit, retire, inventory |

## Session model

- `SessionController` owns the access token (memory only), its conservative expiry, profile confirmation and an identity **revision** number.
- Reload restores the session through the refresh cookie, then confirms it with `GET /users/me` before showing the identity.
- Web Locks serialize login, refresh, logout and guest-cookie changes across tabs. BroadcastChannel carries fixed notice strings only, never tokens or profile data. **If either API is missing, the app fails closed.** There is no storage fallback.
- `SessionBoundary` rechecks the profile on each protected navigation. `AdminBoundary` also requires the server role. Guards only improve the UX; the API enforces everything.
- Private components call `usePrivateSession()`. Each request is pinned to the revision that created it. A change of identity or role destroys the private subtree, aborts requests and ignores late responses.
- One `CartController` above the routes holds the cart for the current owner (account or guest), so a submitted write can finish across SPA navigation.

## Routes

| Route | Access |
|---|---|
| `/` | Public catalog: `q`, `offset`, page size 20 |
| `/products/:productId` | Public product detail |
| `/signup`, `/login` | Public; `returnTo` is validated against an allowlist |
| `/forgot-password`, `/reset-password` | Public; the reset page has a minimal layout |
| `/verify-email`, `/confirm-email-change` | Minimal pages that capture the email token |
| `/account`, `/account/security` | Signed in |
| `/account/addresses`, `/account/addresses/new`, `/account/addresses/:addressId/edit` | Signed in |
| `/cart`, `/checkout`, `/orders`, `/orders/:orderId` | Account or guest owner |
| `/guest/orders`, `/guest/orders/:orderId` | Full guest cookie, or an order-scoped recovery grant |
| `/guest/checkout/:intentId` | Intent-scoped recovery grant |
| `/guest/recover` | Mailbox proof landing page |
| `/admin`, `/admin/products`, `/admin/products/new`, `/admin/products/:productId`, `.../edit`, `.../inventory` | Current admin |
| `*` | Not-found page |

Route parameters are UUIDs. An invalid ID shows the not-found view without making a request. A missing resource and a resource owned by someone else show the same view.

## Configuration

`VITE_API_BASE_URL` defaults to `http://localhost:8080/api/v1`. It is either an absolute URL or exactly `/api/v1`, which `resolveApiBaseUrl` resolves against `window.location.origin` (same-origin serving from the Go API). The resolved URL must end in `/api/v1`, use HTTPS (loopback HTTP is allowed), and contain no credentials, query or fragment. Storage and lock names use the resolved absolute URL, so they stay stable per origin and existing dev keys are unchanged. The value is **fixed at build time** and public. Override it in `frontend/.env.local`; `npm run build:same-origin` builds with `/api/v1` regardless of `.env` files.

Vite's `publicDir` is `../fixtures/public`, so `/fixtures/v1/*.svg` product images are served and copied into `dist/`.

## Build and bundles

`npm run build` type-checks, then builds into `dist/`. Routes are code-split. The largest chunk is about 433 kB, close to Vite's default 500 kB warning. `npm run preview` (port 4173) is for local inspection only and is not a deployment server.
