# Frontend architecture

React 19 and TypeScript, built with Vite, routed with React Router, and styled with Tailwind 4 and project-owned shadcn components. In production, the built SPA is either served by the Go API from the same origin, or published to S3 behind CloudFront with `/api/*` routed to the API. Either way, the browser sees one origin.

## Design choices

| Choice | Why | Trade-off accepted |
|---|---|---|
| **No state, HTTP, form or icon library**: native `fetch`, React context and hooks, native forms | The requirements don't need them, and every dependency is something to audit and upgrade | More hand-written code for loading states and forms |
| **One typed API client** with runtime guards on every response, checked against OpenAPI by a test; no code generator | Error, retry and credential rules live in one place, and a malformed response is caught at the boundary | Types are maintained by hand next to the contract |
| **Access token in memory only**; the session is restored from the `HttpOnly` refresh cookie on reload | Nothing that XSS can steal from storage | A refresh call on every page load |
| **Web Locks and BroadcastChannel are required**; if either is missing, the app fails closed | Sign-in, refresh, sign-out and checkout are serialised across tabs without putting tokens in storage | Very old browsers can't use the app |
| **Requests are pinned to an identity revision.** A change of user or role destroys the private subtree, aborts requests and ignores late responses | One user's data can never flash up for the next user after a sign-out | Some reloads after identity changes |
| **Writes are sent once.** Only reads (and a name-only profile edit) may replay after a definitive 401 | A replayed mutation could duplicate a committed change | The user sometimes has to retry deliberately |
| **One cart controller above the routes** | A submitted write finishes even if the user navigates away | A shared component that every cart view depends on |
| **Tailwind with a `tw:` prefix and no Preflight, next to the existing CSS Modules** | Pages migrated one at a time without breaking the rest | Two styling systems coexist |
| **The API base URL is fixed at build time** (`/api/v1` for same-origin builds) | One build runs on any HTTPS host | Changing the API host needs a rebuild |
| **Exact dependency pins**, `engine-strict`, `npm ci` only, strict peer dependencies | Reproducible installs; nothing drifts between machines | Upgrades are deliberate work |

## Layout

| Path | Owns |
|---|---|
| `src/main.tsx` | Removes token fragments from the URL before the router mounts |
| `src/app/` | Route table and render-error boundary |
| `src/shared/api/` | API client, base-URL validation, response guards, guest transport, deadlines |
| `src/shared/ui/` | Layout, header, search, fields, notices, async states, money; `primitives/` holds the shadcn components |
| `src/features/auth/` | Session controller, route guards, sign-in and sign-up, cross-tab coordination |
| `src/features/catalog/`, `cart/`, `checkout/`, `orders/`, `account/`, `admin/` | One folder per feature |

## Session model

- `SessionController` owns the in-memory access token, its expiry, profile confirmation and an identity **revision**.
- On reload, the refresh cookie restores the session, and `GET /users/me` confirms it before any identity is shown.
- Web Locks serialise sign-in, refresh, sign-out and guest-cookie changes across tabs. BroadcastChannel carries only fixed notice strings, never tokens or profile data.
- The route guards (`SessionBoundary`, `AdminBoundary`) only improve the UX. The API enforces every rule.

## Routes

| Routes | Access |
|---|---|
| `/`, `/products/:id`, `/signup`, `/login`, `/forgot-password`, `/reset-password` | Public |
| `/verify-email`, `/confirm-email-change`, `/guest/recover` | Minimal pages that capture an emailed token from the URL fragment |
| `/account/*` | Signed in |
| `/cart`, `/checkout`, `/orders/*` | Account or guest owner |
| `/guest/orders/*`, `/guest/checkout/:intentId` | Guest cookie, or a recovery grant scoped to that order or intent |
| `/admin/*` | Current admin (rechecked on the server) |

Route parameters must be UUIDs. A missing resource and someone else's resource show the same not-found view.

## Known limits

- The largest JavaScript chunk is about 433 kB, close to Vite's 500 kB warning.
- Tested in Chromium only.
