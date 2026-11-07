# Milestone 14: production serving and HTTPS

**Goal:** the Go API serves the built SPA and the API from one HTTPS origin, with verified database TLS and production-mode configuration. This proves the application works the way it will be deployed, before packaging begins.

**State:** in progress (tasks 1–5 of 10 done: decisions recorded in [DECISIONS.md](DECISIONS.md#production-serving-and-https-milestone-14); local certificates via `scripts/certs.sh`; TLS listener, Secure cookie rule and HSTS; `STATIC_DIR` SPA serving; relative `/api/v1` frontend base). Task breakdown: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md#milestone-14--production-serving-and-https). Packaging, Compose deployment and the release tag move to [Milestone 15](MILESTONE_15.md).

## Why a separate milestone

HTTPS changes how the app behaves: Secure cookies, origins, SPA routing, the API base URL and database TLS. Proving that first keeps packaging failures distinguishable from application failures. M15 then packages an app that already runs correctly over HTTPS.

## Selected design

| Decision | Choice | Reason |
|---|---|---|
| TLS termination | **In the Go API** (`ListenAndServeTLS`), with no reverse proxy | Keeps the "no proxy" decision. `RemoteAddr` stays the real client, so rate limits remain correct. |
| Origins | **Same origin.** The API serves `dist/` and the API from one host and port. | One cookie site; no CORS needed in production; email links resolve to the same server. |
| SPA routing | Fall back to `index.html` for page navigations outside `/api/`, `/health/` and `/metrics` | Direct navigation and email links work; API 404s stay JSON. |
| Frontend API base | Also accept a relative `/api/v1`, resolved against the page origin | One build works on any HTTPS host. The absolute URL stays for the Vite dev server. |
| Local certificates | `scripts/certs.sh` (OpenSSL) creates a local CA and server certificates in `.cache/certs/` | No new tool; OpenSSL is already required. `mkcert` remains an optional convenience. |
| Database TLS | PostgreSQL `ssl=on` with a certificate from the local CA; production URLs use `sslmode=verify-full&sslrootcert=…` | Satisfies the existing production rule without weakening it. |
| Development default | Unchanged. Vite on `http://localhost:5173`, API on `http://localhost:8080`, database without TLS. | Daily work and the 348-test suite are unaffected. HTTPS is an additional run mode. |

## Configuration contract

New settings, read by the API only:

| Key | Rule |
|---|---|
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | Both set or both empty (empty means unset). Files must be readable at startup. **Required in production.** |
| `STATIC_DIR` | Optional path to a built `dist/`. When set, the API serves the SPA. It must contain `index.html`. |

Rule changes:

- **Secure cookies** turn on when `APP_ENV=production` **or** TLS is enabled. Today they depend only on production mode.
- **TLS version** minimum is 1.2.
- **HSTS** (`Strict-Transport-Security`) is sent **only in production with TLS**. Sending it from `localhost` would force HTTPS on every localhost port, including the Vite dev server.
- **Local mode** may use TLS on a loopback address, for example `https://localhost:8443`.
- **Production mode** already allows a non-loopback bind, an HTTPS origin, `verify-full` and SMTP. Those rules stay as they are.

Run modes after M14:

| Mode | Frontend | API | Database |
|---|---|---|---|
| Development (default) | Vite `http://localhost:5173` | `http://localhost:8080` | No TLS |
| Local HTTPS | Served by the API | `https://localhost:8443` | No TLS, or `verify-full` |
| Browser test, HTTP (existing) | Vite :5173 | `http://localhost:18080` | Fixture database |
| Browser test, HTTPS (new) | Served by the API | `https://localhost:18443` | Fixture database |
| Production smoke | Served by the API | HTTPS, production mode | `verify-full` |

## Static serving rules

- Request matching runs in this order: API routes, then health and metrics, then static files, then the SPA fallback.
- Fall back to `index.html` only for `GET` and `HEAD` requests without a file extension. `/api/*` and asset paths always return a real 404.
- Serve only files under `STATIC_DIR`. No directory listings, no dotfiles, no path traversal.
- Caching: `index.html` gets `no-cache`. Hashed files under `/assets/` get `max-age=31536000, immutable`. `/fixtures/v1/*.svg` gets a short cache.
- Every HTML response gets `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
- The build output must contain no catalog JSON, fixture bundles or `.env` files.

## Release gates for M14

1. **Static serving and fallback.** Direct navigation and reload work for every route family and email-link page, unknown API paths return JSON 404, and the caching and security headers are as specified.
2. **TLS.** The API serves HTTPS with the configured certificate and refuses half-configured TLS. Cookies are Secure, and HSTS is present only in production.
3. **Database TLS.** `verify-full` connects with the local CA and fails on a wrong host name or an untrusted CA.
4. **Browser behavior over HTTPS.** Sign-in, reload and refresh, guest cart and checkout, both payment scenarios, orders and an email-link page pass in the HTTPS browser group.
5. **Production mode.** The API starts in production mode with TLS, `verify-full` and SMTP, serves the SPA, and a real verification email link opens on the HTTPS origin.
6. **Regression.** The backend check and integration `--race` suite, frontend unit, type and build checks, and the full existing browser suite all still pass.

## Risks

| Risk | Mitigation |
|---|---|
| Playwright's headless Chromium may not trust the local CA | The HTTPS test project uses `ignoreHTTPSErrors`. The certificate chain itself is verified separately by Go tests. |
| The PostgreSQL key file needs strict ownership in the container | Copy the key into the container with mode 0600 owned by the `postgres` user, rather than bind-mounting it directly. |
| Recovery-record storage keys include the API base | The resolved absolute URL keeps keys stable per origin. Dev and HTTPS origins use separate namespaces, which is expected. |
| Chunk-size warning | Track only; not a gate. |

## Out of scope

The application image, Compose deployment, release evidence and tag (M15). Also out of scope: an HTTP-to-HTTPS redirect listener, automatic certificates (ACME), a reverse proxy, CSP hardening beyond the headers above, and multi-instance deployment.
