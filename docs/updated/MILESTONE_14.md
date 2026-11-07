# Milestone 14: final baseline release

**Goal:** ship Project 1 as a packaged, verified, tagged application that Projects 2–6 can fork without changing its healthy behavior.

**State:** not started. Milestones 1–13 pass on Ubuntu.

## Release gates

1. **Regression.** All M1–M13 behavior, endpoint mappings and visual regressions pass. Any remaining limits are written down.
2. **Packaging.** The production frontend build and the Go API are served from one application image. Direct navigation to SPA routes works; `/api/v1/*`, `/health/*` and `/metrics` keep their current behavior.
3. **Deployment.** Compose deployment, explicit migrations, readiness, real browser journeys and order recovery pass against an owned test database. Credentials and live data stay out of the image. No development volume is reset.
4. **Evidence.** Record tool and image versions (including the `postgres:16-alpine` digest), source commit, fixture and schema versions, image digest and reproducible run instructions.
5. **Tag.** Tag the healthy baseline.

## Blockers found in the current code

These must be resolved, or deliberately accepted and documented, before gates 2–3 can pass.

| # | Issue | Where | Why it matters |
|---|---|---|---|
| 1 | No TLS listener; the server calls plain `ListenAndServe` | `backend/cmd/api/main.go` | Production requires HTTPS and Secure cookies. Either add TLS or terminate it in front of the API. Adding a proxy changes the "no reverse proxy" decision. |
| 2 | Production config requires `FRONTEND_ORIGIN` on HTTPS, `sslmode=verify-full` and `MAIL_MODE=smtp` | `backend/internal/platform/config/config.go` | A Compose deployment needs a database with verifiable TLS certificates and working SMTP, or a deliberate local-mode release profile. |
| 3 | Local mode requires a loopback `HTTP_ADDR` | same | Inside a container the API must bind to a non-loopback address, which local mode rejects. |
| 4 | Unknown paths return JSON 404 and there is no static file serving | `backend/internal/platform/httpserver/server.go` | The SPA needs an `index.html` fallback for client routes, without masking API 404s. |
| 5 | Email links point to SPA routes (`/verify-email`, `/confirm-email-change`, `/reset-password`, `/guest/recover`) built from `FRONTEND_ORIGIN` | account security and guest mail | They only work once item 4 is fixed and the origin is the public HTTPS address. |
| 6 | `VITE_API_BASE_URL` is fixed at build time | `frontend/src/shared/api/config.ts` | The image must be built for its final origin, or switch to same-origin relative calls. Both choices affect CORS and cookies. |
| 7 | Product images use `/fixtures/v1/*.svg` from Vite's public directory | `frontend/vite.config.ts` (`publicDir: '../fixtures/public'`) | The packaged server must serve these files. Private fixture bundles must never be included. |
| 8 | Rate limits are keyed on `RemoteAddr` | auth and guest limiters | Behind a proxy, every client shares one key. A proxy needs a trusted-proxy rule. |
| 9 | Migrations are a separate step; the API never migrates | by design | The deployment needs an explicit migration job before the API starts. |
| 10 | Largest JS chunk is about 433 kB, near Vite's 500 kB warning | frontend build | Track it; not a blocker by itself. |

## Suggested order

1. Decide the serving model: same-origin SPA plus API from one Go binary, or a proxy. This choice settles items 1, 4, 6 and 8 together.
2. Add static serving with SPA fallback, limited to non-API paths, plus tests for direct navigation and API 404s.
3. Add a release Dockerfile (multi-stage: Node build, Go build, minimal runtime) and a Compose profile with a migration job.
4. Provide database TLS and SMTP for production mode, or define and document a release profile that does not need them.
5. Run all gates against the packaged stack, record the evidence and tag.

## Not part of M14

New features, scenario faults (those belong to Projects 2–6), background workers, real payments and multi-instance scaling.
