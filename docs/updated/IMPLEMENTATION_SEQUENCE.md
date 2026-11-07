# Implementation sequence

**Updated:** 2026-11-07.  
**Progress:** Milestones 1–13 are complete. Milestone 14 (production serving and HTTPS) is in progress (tasks 1–4 of 10 done), then Milestone 15 (final release).

## How to use this file

1. Work on **one task at a time**, in order, unless a task says it can run in parallel.
2. Before starting, read the milestone document ([M14](MILESTONE_14.md), [M15](MILESTONE_15.md)) and the topic documents the task names.
3. A task is done only when its **Done when** items and its **Verify** gate pass. Record what actually ran.
4. After each verified task, tick its box here and update [STATUS.md](STATUS.md). Update the topic documents in the same change as the code.
5. If a task uncovers a design problem, stop and record the decision in [DECISIONS.md](DECISIONS.md) before continuing.

Verification levels follow [frontend/TESTING.md](frontend/TESTING.md#when-to-run-what): changes to shared API configuration, cookies, routing or the harness require the **full** browser suite.

## Milestones 1–13 (complete)

| # | Milestone | Detail |
|---|---|---|
| 1–5 | Backend: core database, transactional orders, simulated payment, recovery, readiness | [backend sequence](../backend/IMPLEMENTATION_SEQUENCE.md) |
| 6–13 | Frontend: design, auth, catalog, account and cart, checkout, admin, visual design, shopping revision and guest checkout | [frontend sequence](../frontend/IMPLEMENTATION_SEQUENCE.md) |

## Milestone 14 — Production serving and HTTPS

Status: **in progress** — tasks 1–4 done (2026-11-07). Design: [MILESTONE_14.md](MILESTONE_14.md).

1. [x] **Record the serving and TLS decisions**
   - Add the M14 choices to [DECISIONS.md](DECISIONS.md): Go-native TLS, same origin, SPA fallback rules, relative API base, the Secure cookie rule, HSTS only in production, local CA tooling and database TLS.
   - Add the new settings (`TLS_CERT_FILE`, `TLS_KEY_FILE`, `STATIC_DIR`) to `.env.example` as commented, empty entries.
   - **Done when:** the decisions and config contract match MILESTONE_14.md, and no code has changed yet.
   - **Verify:** documentation links pass.
   - **Result (2026-11-07):** decisions added to [DECISIONS.md](DECISIONS.md#production-serving-and-https-milestone-14); `.env.example` gains commented `TLS_CERT_FILE`, `TLS_KEY_FILE` and `STATIC_DIR`. Both env loaders skip comments, so `init-env` and existing `.env` files are unaffected. Links pass. No code changed.

2. [x] **Local certificate tooling**
   - Add `scripts/certs.sh`. It uses OpenSSL to create a local CA and a server certificate in `.cache/certs/` (git-ignored).
   - Subject names: `localhost`, `127.0.0.1` and `::1` for the API, and `localhost` plus `postgres` for the database.
   - The script refuses to overwrite existing files, sets key files to mode 0600, and prints only file paths.
   - Document how to trust the CA in a desktop browser, with `mkcert` noted as an optional alternative.
   - **Done when:** running the script twice is safe, and `openssl verify -CAfile ca.pem server.pem` passes.
   - **Verify:** run the script; `bash -n scripts/certs.sh`.
   - **Result (2026-11-07):** `scripts/certs.sh` creates an EC P-256 CA (10 years, `pathlen:0`) plus `server` and `postgres` certificates (397 days, `serverAuth`, the listed SANs). Files are assembled in a temporary directory and moved into place without overwriting; directory 0700, keys 0600. Checked in a scratch copy: a second run only verifies; an incomplete set, a mismatched key and unexpected arguments all fail without changes; `openssl verify` passes for both leaves; an `openssl s_server` handshake verifies for `localhost` and fails with a hostname mismatch for another name. The real set now exists in the ignored `.cache/certs/`. Browser trust steps are in [DEVELOPMENT.md](DEVELOPMENT.md#local-https-certificates). No application code changed.

3. [x] **TLS listener and configuration**
   - In `config.go`, parse `TLS_CERT_FILE` and `TLS_KEY_FILE`. Both or neither may be set, the files must be readable, and production requires them.
   - In `cmd/api/main.go`, use `ListenAndServeTLS` when TLS is configured, with `MinVersion: tls.VersionTLS12`.
   - Secure cookies turn on when the environment is production **or** TLS is on. This applies to `ecom_refresh`, `ecom_guest` and `ecom_guest_recovery`.
   - Add HSTS (`max-age=31536000`) only when production and TLS are both on.
   - **Done when:** half-configured TLS fails at startup with a clear error, an HTTPS request succeeds with the test certificate, and cookie attributes match the rule in every mode.
   - **Verify:** config unit tests for every combination, server tests with a generated certificate, cookie assertions, and `bash scripts/dev.sh check` plus `integration --race`.
   - **Result (2026-11-07):** `config.Load` reads `TLS_CERT_FILE` and `TLS_KEY_FILE`, rejects a half pair, and requires both in production. `Config.SecureCookies()` (production or TLS) and `Config.HSTS()` (production and TLS) drive all three cookies and the header from one place. `httpserver.EnableTLS` loads the pair before listening (TLS 1.2 minimum), and `main.go` uses `ListenAndServeTLS` and sends server messages to the JSON log. Tests:
     - config cases for every mode and pair combination
     - an HTTPS round trip with a generated certificate, rejecting a TLS 1.1 client and a client without the CA
     - missing, mismatched and swapped files
     - HSTS middleware
     - a new `ecom_guest_recovery` attribute test, alongside the existing `ecom_refresh` and `ecom_guest` tests

     `check` and `integration --race` pass. A manual run with the binary and `.cache/certs/` showed:
     - a half pair and a mismatched key each stop startup with a clear error
     - `https://localhost:8443` and `https://127.0.0.1:8443` verify against `ca.pem`, and a client without the CA is refused
     - logout clears `ecom_refresh` with `Secure` over HTTPS and without it over HTTP
     - no HSTS in local mode

     Production-mode HSTS is covered by tests only until task 9.

4. [x] **Static SPA serving with fallback**
   - Add an optional static handler, enabled only by `STATIC_DIR`. Startup fails if `index.html` is missing.
   - Request order: `/api/v1/*`, then `/health/*` and `/metrics`, then static files, then the `index.html` fallback. The fallback covers only `GET` and `HEAD` requests without a file extension.
   - Unknown `/api/*` paths keep the JSON 404. Missing asset files return a plain 404.
   - Block dotfiles, directory listings and path traversal.
   - Caching: `no-cache` for `index.html`; `max-age=31536000, immutable` for `/assets/*`; a short cache for `/fixtures/v1/*`.
   - HTML responses get `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
   - **Done when:** every frontend route and every email-link path (`/verify-email`, `/confirm-email-change`, `/reset-password`, `/guest/recover`) returns `index.html`, and API and operational routes behave exactly as before.
   - **Verify:** handler unit tests using `fstest.MapFS` (route matrix, traversal, HEAD, headers), plus `check` and `integration --race`.
   - **Result (2026-11-07):** `httpserver.Static` opens `STATIC_DIR` with `os.Root` and requires a regular `index.html`; `httpserver.SPA` replaces only the root fallback, so API subrouters keep the JSON 404. `main.go` checks the directory before connecting to the database. `config` gains `StaticDir`.
     - The route-matrix tests cover every route family and email-link path, files with their cache headers, dotfiles, traversal, HEAD, API and operational routes, and non-GET methods.
     - A real-directory test shows that sibling files and symbolic links pointing out of the root are not served.
     - Without `STATIC_DIR`, every unknown path still returns the JSON 404.
     - `check` and `integration --race` pass.
     - A manual HTTPS run with the real `frontend/dist` behaved as specified. Unknown `/api/v1/*` GETs return a JSON 405 rather than a 404, because of the existing `OPTIONS /*` preflight route. This is unchanged and also happens without `STATIC_DIR`.

5. [ ] **Same-origin frontend API base**
   - In `resolveApiBaseUrl`, also accept the relative value `/api/v1` and resolve it against `window.location.origin`. Keep the HTTPS-or-loopback rule on the resolved URL.
   - The resolved absolute URL continues to name the storage and lock keys, so keys stay stable per origin.
   - Add a `build:same-origin` script (`VITE_API_BASE_URL=/api/v1 vite build`). The default dev behavior is unchanged.
   - **Done when:** the relative and absolute forms both pass validation tests, invalid forms are still rejected, and recovery-record keys are unchanged for the dev origin.
   - **Verify:** `npm test`, `npm run typecheck`, `npm run build`, and the **full** `npm run test:e2e` (shared API configuration changed).

6. [ ] **Database TLS**
   - Add a Compose override, `compose.tls.yaml`, that enables `ssl=on` with the task 2 certificate. The key is copied into the container with mode 0600, owned by the `postgres` user. The default `compose.yaml` is unchanged.
   - Add `bash scripts/dev.sh database-tls` (or a flag) to start the database with the override.
   - Add an opt-in integration test. It connects with `sslmode=verify-full&sslrootcert=.cache/certs/ca.pem`, and fails for a wrong host name and for an untrusted CA.
   - **Done when:** `verify-full` works against the local container, and the default development flow still uses `sslmode=disable`.
   - **Verify:** the opt-in TLS test, the normal `integration --race`, and `docker compose config --quiet` for both files.

7. [ ] **Local HTTPS run mode**
   - Add `bash scripts/dev.sh serve-https`. It builds the frontend with the same-origin base, then runs the API in local mode on `https://localhost:8443` with TLS, `STATIC_DIR=frontend/dist` and `FRONTEND_ORIGIN=https://localhost:8443`.
   - Document the mode in [DEVELOPMENT.md](DEVELOPMENT.md).
   - **Done when:** in a browser that trusts the local CA you can sign in, reload, shop as a guest, check out with both scenarios, view orders and open an admin page, all on `https://localhost:8443`.
   - **Verify:** a manual smoke checklist recorded in STATUS.md.

8. [ ] **HTTPS browser test group**
   - Add a harness mode. It builds `dist` once per run, then for each test starts the API with TLS and `STATIC_DIR` on `https://localhost:18443` instead of using Vite. Fixtures stay per test.
   - Add a Playwright project or group, `test:e2e:https`, with `ignoreHTTPSErrors` for that project only. Update the group-coverage unit test.
   - Cases to cover:
     - deep-link navigation and reload for each route family
     - `Secure`, `HttpOnly` and `SameSite` attributes on all cookies (`context.cookies()`)
     - session restore after reload
     - guest cart, choice and checkout (accept and reject)
     - order detail and cancellation
     - an email-link page with a fragment
     - a JSON 404 for an unknown API path
     - cache headers on `index.html` and assets
   - **Done when:** the HTTPS group passes with one worker and zero retries, and the existing HTTP suite is unchanged.
   - **Verify:** `npm run test:e2e:https`, then the **full** `npm run test:e2e` (the harness changed).

9. [ ] **Production-mode smoke**
   - Run the API with `APP_ENV=production`, TLS, `DATABASE_URL` using `verify-full` (task 6), `MAIL_MODE=smtp` (your configured SMTP) and `STATIC_DIR`. Use a non-loopback bind if needed.
   - Check the health routes, Secure cookies and HSTS. Request a verification email and open its link on the HTTPS origin.
   - **Done when:** production mode starts and serves the SPA, and a real email link opens and completes on HTTPS.
   - **Verify:** a manual run recorded in STATUS.md, without copying any secrets.

10. [ ] **Milestone acceptance**
    - Run `bash scripts/dev.sh check`, `integration --race`, `npm run typecheck`, `npm test`, `npm run build`, the full `npm run test:e2e` and `npm run test:e2e:https`.
    - Update [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md), [backend/OPERATIONS.md](backend/OPERATIONS.md), [frontend/ARCHITECTURE.md](frontend/ARCHITECTURE.md), [frontend/TESTING.md](frontend/TESTING.md) and [STATUS.md](STATUS.md).
    - **Done when:** all M14 gates in [MILESTONE_14.md](MILESTONE_14.md#release-gates-for-m14) pass, and their limits are recorded.

Acceptance: the application runs correctly from one HTTPS origin in both local and production modes, with database TLS verified, while the default development flow and all existing tests are unchanged.

## Milestone 15 — Final baseline release

Status: **not started**; follows M14. Design: [MILESTONE_15.md](MILESTONE_15.md).

1. [ ] **Choose the packaging options.** Decide on the migration job, runtime base image and secret handling, and record them in DECISIONS.md.
2. [ ] **Application image.** A multi-stage Dockerfile builds `dist` (pinned Node) and the API (pinned Go), then copies both into a minimal non-root runtime. Include a `.dockerignore` that excludes `.cache/`, `.env*`, `node_modules/` and fixture bundles.
3. [ ] **Compose deployment profile.** Services start in order: PostgreSQL with TLS, then a migration job that must succeed, then the API. Health checks gate the order. Secrets are supplied at runtime. The default dev Compose is unchanged.
4. [ ] **Deployment verification.** Against an owned test database: readiness, the HTTPS browser group against the container, the recovery CLI run inside the deployment, and a restart that keeps data.
5. [ ] **Release evidence.** Record tool versions, image digests, the commit, schema 13, fixture version 1, OpenAPI 1.7.0, test results and run instructions.
6. [ ] **Tag the baseline.** Create an annotated tag on the verified commit, and update STATUS.md.

Acceptance: a fresh machine can run the tagged release from the documented instructions, and every gate in [MILESTONE_15.md](MILESTONE_15.md) has recorded evidence.
