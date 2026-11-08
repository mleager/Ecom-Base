# Implementation sequence

**Updated:** 2026-11-07.  
**Progress:** Milestones 1–14 are complete (M14, production serving and HTTPS, accepted 2026-11-07). Next are Milestone 15 (observability), Milestone 16 (final release) and Milestone 17 (CDN frontend and load-balanced API).

## How to use this file

1. Work on **one task at a time**, in order, unless a task says it can run in parallel.
2. Before starting, read the milestone document ([M14](MILESTONE_14.md), [M15](MILESTONE_15.md), [M16](MILESTONE_16.md), [M17](MILESTONE_17.md)) and the topic documents the task names.
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

Status: **complete** — all 10 tasks done and accepted (2026-11-07). Design: [MILESTONE_14.md](MILESTONE_14.md).

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

5. [x] **Same-origin frontend API base**
   - In `resolveApiBaseUrl`, also accept the relative value `/api/v1` and resolve it against `window.location.origin`. Keep the HTTPS-or-loopback rule on the resolved URL.
   - The resolved absolute URL continues to name the storage and lock keys, so keys stay stable per origin.
   - Add a `build:same-origin` script (implemented as `vite build --mode same-origin`, which defines `VITE_API_BASE_URL=/api/v1` and works on any shell). The default dev behavior is unchanged.
   - **Done when:** the relative and absolute forms both pass validation tests, invalid forms are still rejected, and recovery-record keys are unchanged for the dev origin.
   - **Verify:** `npm test`, `npm run typecheck`, `npm run build`, and the **full** `npm run test:e2e` (shared API configuration changed).
   - **Result (2026-11-07):** `resolveApiBaseUrl` accepts exactly `/api/v1` (or `/api/v1/`) and resolves it against the page origin (an optional `origin` argument for tests). It fails when there is no usable origin, and then applies the same HTTPS-or-loopback, no-credentials, no-query rules. Protocol-relative and other relative forms are still rejected.
     - `build:same-origin` uses a Vite mode rather than an environment prefix. It is cross-platform and overrides `.env.local`. The built bundle calls `resolveApiBaseUrl("/api/v1")`, while the default build keeps the absolute default.
     - New unit tests cover the resolution, the rejection cases, and pinned recovery storage names (the dev-origin name is unchanged).
     - `npm run typecheck`, `npm test` (1,368), both builds and the **full** `npm run test:e2e` pass: 348/348 in about 18.5 minutes, pinned away from CPUs 8–9.
     - The first e2e attempt failed at browser launch because `PLAYWRIGHT_BROWSERS_PATH` pointed at the Windows-only `.cache/playwright`. This was environmental, and the docs now warn about it.

6. [x] **Database TLS**
   - Add a Compose override, `compose.tls.yaml`, that enables `ssl=on` with the task 2 certificate. The key is copied into the container with mode 0600, owned by the `postgres` user. The default `compose.yaml` is unchanged.
   - Add `bash scripts/dev.sh database-tls` (or a flag) to start the database with the override.
   - Add an opt-in integration test. It connects with `sslmode=verify-full&sslrootcert=.cache/certs/ca.pem`, and fails for a wrong host name and for an untrusted CA.
   - **Done when:** `verify-full` works against the local container, and the default development flow still uses `sslmode=disable`.
   - **Verify:** the opt-in TLS test, the normal `integration --race`, and `docker compose config --quiet` for both files.
   - **Result (2026-11-07):**
     - **Override:** `compose.tls.yaml` mounts only `postgres.pem` and `postgres.key`, read-only. Its entrypoint installs them as `postgres:postgres` (certificate 0644, key 0600) in `/var/lib/postgresql/tls`, then runs the image entrypoint with `ssl=on` and `ssl_min_protocol_version=TLSv1.2`. TLS is offered, not required, so `sslmode=disable` still works.
     - **`dev.sh` actions:** `database-tls` checks for the certificates first, because Docker would otherwise create missing mount sources as directories. `database-tls-check` runs `TestDatabaseTLS` (opt-in via `ECOM_DB_TLS=1`; skipped in normal runs).
     - **Test results against the TLS container:** `verify-full` passed for `localhost` and `127.0.0.1` (TLSv1.2/1.3 per `pg_stat_ssl`), the URL satisfies `config.ValidateDatabase("production", …)`, and the API pool connects over TLS. A wrong host name fails with an `x509.HostnameError`; another CA and system-roots-only both fail with `x509.UnknownAuthorityError`; `sslmode=disable` still connects without TLS.
     - **Against the plain container:** every TLS case fails clearly with "server refused TLS".
     - **API run:** the API with a `verify-full` `DATABASE_URL` reached readiness 200.
     - **Gates:** `integration --race` passed with the TLS container running, `check` passes, and `docker compose config --quiet` passes for both file sets.
     - **Restore:** the development container was switched back with `bash scripts/dev.sh database` (schema still at version 13).

7. [x] **Local HTTPS run mode**
   - Add `bash scripts/dev.sh serve-https`. It builds the frontend with the same-origin base, then runs the API in local mode on `https://localhost:8443` with TLS, `STATIC_DIR=frontend/dist` and `FRONTEND_ORIGIN=https://localhost:8443`.
   - Document the mode in [DEVELOPMENT.md](DEVELOPMENT.md).
   - **Done when:** in a browser that trusts the local CA you can sign in, reload, shop as a guest, check out with both scenarios, view orders and open an admin page, all on `https://localhost:8443`.
   - **Verify:** a manual smoke checklist recorded in STATUS.md.
   - **Result (2026-11-07):**
     - `dev.sh serve-https [fixture-id]` checks the certificates and `node_modules`, runs `build:same-origin`, then runs the API with the HTTPS settings overriding `.env`.
     - `dev.sh fixtures-https` creates a fixture whose image URLs and `api.env` use `https://localhost:8443`.
     - The smoke checklist in [STATUS.md](STATUS.md#local-https-smoke-m14-task-7-2026-11-07) passed in headless Chromium with `ignoreHTTPSErrors`. The certificate chain was verified separately with `curl --cacert`.
     - The script's first runs hit the API's in-memory rate limits (429) and two races in the smoke script itself; the server was restarted between runs.
     - **Still to do:** the same walk-through in a desktop browser that trusts `ca.pem`.

8. [x] **HTTPS browser test group**
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
   - **Result (2026-11-07):**
     - **Harness:** `backend.ts` gains a worker-scoped `transport` option. For `https` it:
       - builds the same-origin SPA once per run into `.cache/frontend-e2e-https/dist`
       - starts each fixture API on `https://localhost:18443` with the `.cache/certs` key pair and `STATIC_DIR`
       - probes readiness with the chain verified against `ca.pem`
       - exposes `backend.origin` for CSRF headers

       The mail-enabled API variant (`TestBrowserMailAPI`) honors `TLS_CERT_FILE`, `TLS_KEY_FILE` and `STATIC_DIR` too, so order cancellation runs over TLS. `playwright.https.config.ts` runs `tests/e2e-https/` with `ignoreHTTPSErrors` in its one project. Every test there starts its own API automatically.
     - **Ten cases**, all listed in [frontend/TESTING.md](frontend/TESTING.md#https-browser-group). Beyond the list above, they add a leftover plain-HTTP cookie that must not block the guest cart. `browserGroups.test.ts` checks the separate config and directory.
     - **Bug found and fixed:** every unknown `/api/v1` path answered **405** instead of a JSON 404, because the catch-all `OPTIONS /*` preflight route matched every path. Preflights are now answered by middleware before routing (`auth.answerPreflight`). Real routes with the wrong method stay 405. Unit cases were added in `TestCSRFAndCORS`.
     - **Runs:**
       - `npm run test:e2e:https`: 10/10 in about 58 s
       - `integration --race`, `check`, `npm run typecheck`, `npm test` (1,369) and `npm run build`: pass
     - **Full `npm run test:e2e`: 347/348.** The one failure, `guest-contract.spec.ts:34` (two tabs add to the cart at once, both badges expect 2), is intermittent and predates this task. It failed 1 of 5 isolated runs with this change, and 4 of 8 with the preflight change reverted. It was then diagnosed as a real lost add-to-cart click and fixed (see [STATUS.md](STATUS.md#local-https-smoke-m14-task-7-2026-11-07)).

9. [x] **Production-mode smoke**
   - Run the API with `APP_ENV=production`, TLS, `DATABASE_URL` using `verify-full` (task 6), `MAIL_MODE=smtp` (your configured SMTP) and `STATIC_DIR`. Use a non-loopback bind if needed.
   - Check the health routes, Secure cookies and HSTS. Request a verification email and open its link on the HTTPS origin.
   - **Done when:** production mode starts and serves the SPA, and a real email link opens and completes on HTTPS.
   - **Verify:** a manual run recorded in STATUS.md, without copying any secrets.
   - **Result (2026-11-07):** done; every check passed. Details: [STATUS.md](STATUS.md#production-mode-smoke-m14-task-9-2026-11-07).
     - The API ran with `APP_ENV=production` on `127.0.0.1:8443` (TLS, `STATIC_DIR`), `MAIL_MODE=smtp` with the private `.env` SMTP settings, and a `fixtures-https` database through `sslmode=verify-full` against PostgreSQL started with `database-tls`. `pg_stat_ssl` showed the API's connections on TLSv1.3.
     - A real verification email to `ECOM_MAIL_TEST_RECIPIENT` arrived, and its link opened on `https://localhost:8443` and completed verification. The link was opened in headless Chromium, not a desktop browser, because production mode sends HSTS for `localhost`.
     - The first send was reported as unconfirmed; the retry was accepted. See the SMTP limit in [STATUS.md](STATUS.md#known-limits).

10. [x] **Milestone acceptance**
    - Run `bash scripts/dev.sh check`, `integration --race`, `npm run typecheck`, `npm test`, `npm run build`, the full `npm run test:e2e` and `npm run test:e2e:https`.
    - Update [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md), [backend/OPERATIONS.md](backend/OPERATIONS.md), [frontend/ARCHITECTURE.md](frontend/ARCHITECTURE.md), [frontend/TESTING.md](frontend/TESTING.md) and [STATUS.md](STATUS.md).
    - **Done when:** all M14 gates in [MILESTONE_14.md](MILESTONE_14.md#release-gates-for-m14) pass, and their limits are recorded.
    - **Result (2026-11-07):** all six gates pass; every command exited 0 in one sequential run. Gate-by-gate evidence and the remaining limits: [STATUS.md](STATUS.md#m14-acceptance-task-10-2026-11-07). The docs update added a production-mode how-to and troubleshooting rows to [backend/OPERATIONS.md](backend/OPERATIONS.md#production-mode-on-one-host), and the HTTPS group to the run rules in [frontend/TESTING.md](frontend/TESTING.md#when-to-run-what). The two architecture docs were already current.

Acceptance: the application runs correctly from one HTTPS origin in both local and production modes, with database TLS verified, while the default development flow and all existing tests are unchanged.

## Milestone 15 — Observability

Status: **planned**; follows M14. Design: [MILESTONE_15.md](MILESTONE_15.md).

1. [ ] **Confirm the design.**
   - Confirm the SDK and exporters, the `METRICS_ADDR` listener and its bind rules, the source of the pgx tracer (written here or a library), the log shipper, and the pinned stack images.
   - Record them, and the dependency need, in DECISIONS.md.
   - Add `govulncheck` to `check`.
2. [ ] **Telemetry bootstrap.** Add a `platform/telemetry` package. It reads `OTEL_*` and `METRICS_ADDR`, sets up the trace and meter providers, exports nothing when unset, and flushes within the graceful shutdown.
   - **Done when:** startup with nothing set makes no outbound connections, and an unreachable endpoint never delays requests.
   - **Verify:** unit tests and `check`.
3. [ ] **HTTP instrumentation.** Add server spans and RED metrics in the `httpserver` middleware, named by chi route pattern. SPA and static paths get the `static` label; `/health/*` and `/metrics` are skipped. Request logs gain `trace_id` and `span_id`.
   - **Done when:** unknown paths add no series, and no raw URL or query string is recorded.
   - **Verify:** unit tests, and the full browser suite (shared middleware).
4. [ ] **Database instrumentation.** Add a pgx query tracer that records statement text without arguments, and `pgxpool` statistics as gauges.
   - **Done when:** query spans nest under request spans, and a test proves arguments are never exported.
   - **Verify:** `integration --race`.
5. [ ] **Business metrics and mail spans.** Add counters for orders and payment results, unknown checkout outcomes, guest sessions created, rate-limit rejections by limiter, and email failures. Add spans around SMTP sends.
   - **Done when:** each counter has a test that increments it, and the data rules in MILESTONE_15.md hold.
6. [ ] **Local observability stack.**
   - Add `compose.observability.yaml` (Collector, Prometheus, Tempo, Loki with a log shipper, Grafana) and a `dev.sh observability` action.
   - Provision the dashboards and alert rules from files in the repository. Pin all images.
   - **Done when:** the stack starts from a clean checkout, and the default dev Compose is unchanged.
7. [ ] **End-to-end verification.** Run `serve-https` with telemetry on, plus the stack, and run the browser journeys. Check:
   - traces for guest and account checkout
   - dashboards
   - log-to-trace links
   - the readiness and 5xx alerts (stop PostgreSQL) and the latency alert (load test)

   Measure overhead, and record the evidence in STATUS.md.
8. [ ] **Milestone acceptance.**
   - Run `check`, `integration --race`, `npm run typecheck`, `npm test`, `npm run build`, the full `npm run test:e2e` and the HTTPS browser group.
   - Update [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md), [backend/OPERATIONS.md](backend/OPERATIONS.md), [DEVELOPMENT.md](DEVELOPMENT.md), [backend/TESTING.md](backend/TESTING.md) and [STATUS.md](STATUS.md).
   - **Done when:** every gate in [MILESTONE_15.md](MILESTONE_15.md#release-gates-for-m15) passes.

Acceptance: with telemetry configured, every request, query and business outcome is visible as traces, metrics and linked logs in the local stack; with it unset, the application behaves exactly as before.

## Milestone 16 — Final baseline release

Status: **not started**; follows M15. Design: [MILESTONE_16.md](MILESTONE_16.md).

1. [ ] **Choose the packaging options.** Decide on the migration job, runtime base image and secret handling, and record them in DECISIONS.md.
2. [ ] **Application image.** A multi-stage Dockerfile builds `dist` (pinned Node) and the API (pinned Go), then copies both into a minimal non-root runtime. Include a `.dockerignore` that excludes `.cache/`, `.env*`, `node_modules/` and fixture bundles.
3. [ ] **Compose deployment profile.** Services start in order: PostgreSQL with TLS, then a migration job that must succeed, then the API. Health checks gate the order. An optional profile adds the M15 observability stack. Secrets are supplied at runtime. The default dev Compose is unchanged.
4. [ ] **Deployment verification.** Against an owned test database: readiness, the HTTPS browser group against the container, the recovery CLI run inside the deployment, and a restart that keeps data.
5. [ ] **Release evidence.** Record tool versions, image digests, the commit, schema 13, fixture version 1, OpenAPI 1.7.0, test results and run instructions.
6. [ ] **Tag the baseline.** Create an annotated tag on the verified commit, and update STATUS.md.

Acceptance: a fresh machine can run the tagged release from the documented instructions, and every gate in [MILESTONE_16.md](MILESTONE_16.md) has recorded evidence.

## Milestone 17 — CDN frontend and load-balanced API

Status: **planned**; follows the M16 tag. Design: [MILESTONE_17.md](MILESTONE_17.md). The single-host mode from M14–M16 must keep working throughout.

1. [ ] **Choose the options.** Decide the container platform, infrastructure-as-code tool, client IP source, shared rate-limit store, ALB-to-task TLS, secrets, and migration and CI approach. Record them in DECISIONS.md. Audit all process-local state (limiters, slots, counters, caches) and list what must be shared.
2. [ ] **Trusted client IP.** Add one helper used by `auth.allowPeer` and the guest admission and bootstrap limits. It reads the configured trusted proxy header and falls back to `RemoteAddr` when none is configured (local mode).
   - **Done when:** forged headers have no effect without the trusted setting, and the configured header is used with it.
   - **Verify:** unit tests for both cases, plus `check`.
3. [ ] **Upstream TLS setting** (only if task 1 chooses plain HTTP inside the VPC). Add an explicit production setting for "TLS ends upstream". Secure cookies stay on in production, and HSTS moves to CloudFront.
   - **Done when:** half-configured settings are refused, and existing production rules are unchanged without the setting.
   - **Verify:** config tests.
4. [ ] **Shared rate limits.** Move the per-IP and per-key limiters behind an interface. Keep the in-memory store as the default, and add the shared store (for example a PostgreSQL migration `00014`). Concurrency slots stay per task.
   - **Done when:** two handler instances sharing a database enforce one limit.
   - **Verify:** integration test with two instances, `integration --race`, and the full browser suite.
5. [ ] **Frontend publish script.** Add a script that:
   - runs `build:same-origin`
   - uploads `assets/` and `fixtures/` with the cache metadata from the CDN rules, then `index.html` last with `no-cache`
   - keeps the previous release's assets
   - **Done when:** a rerun is idempotent, and no `.env`, fixture bundle or source map lands in the bucket.
6. [ ] **Infrastructure as code.** Define:
   - a private S3 bucket with Origin Access Control
   - CloudFront: a default behavior with the SPA-fallback function, a `/api/*` behavior with caching disabled and viewer headers and cookies forwarded, a response headers policy, and an ACM certificate
   - the ALB: HTTPS listener, CloudFront-only access, health check on `/health/ready`, deregistration delay of at least the 10 s graceful shutdown
   - the ECS service with two or more tasks, RDS PostgreSQL 16, secrets, and log groups
   - **Done when:** `apply` creates it and `destroy` removes it cleanly.
7. [ ] **Deployment pipeline.**
   - Push the image to ECR.
   - Run migrations as a one-off task, then update the service.
   - Publish the frontend.
   - Document how to roll back the image and the frontend.
8. [ ] **Deployment verification.** Run the M14 HTTPS browser group against the CloudFront URL. Also check:
   - client IP and forged-header cases, and that direct ALB access is refused
   - a shared limit across tasks
   - caching and security headers, and that `/metrics` is not reachable
   - a task stopped under traffic, and a rolling deploy with an old tab open
   - the recovery CLI run as a one-off task
9. [ ] **Evidence, teardown and tag.**
   - Record the infrastructure version, image digest, resource identifiers (no secrets) and test results.
   - Write the runbook and teardown in backend/OPERATIONS.md.
   - Update STATUS.md and tag.

Acceptance: the application runs from a CDN and two or more load-balanced API tasks behind one HTTPS origin, with limits that hold per real viewer across tasks, and every gate in [MILESTONE_17.md](MILESTONE_17.md) has recorded evidence.
