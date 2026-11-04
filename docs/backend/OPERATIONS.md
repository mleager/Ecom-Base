# Backend operator guide

Run commands from the repository root. Use local Go 1.25.1, goose 3.27.1 and sqlc 1.31.1; Docker runs only `postgres:16-alpine`. The API/recovery commands run on the host. Frontend setup is in the [application guide](../../frontend/README.md); application images and production HTTPS delivery remain later milestones. [Recovery](RECOVERY.md) owns detailed reconciliation behavior; [decisions](IMPLEMENTATION_DECISIONS.md) explains the policies.

## Security email configuration and verification

Root `.env` uses literal, unquoted `KEY=value` lines. `.env.example` lists the keys. `MAIL_MODE=disabled` is the local default and requires blank SMTP fields; verified password changes still commit with notification `unconfirmed`. Production requires `MAIL_MODE=smtp` and every SMTP field: `SMTP_HOST` (host only), explicit `SMTP_PORT`, lowercase `SMTP_TLS_MODE=tls` for implicit TLS or `starttls` for required STARTTLS, `SMTP_USERNAME`, `SMTP_PASSWORD`, and a single ASCII `MAIL_FROM` mailbox. Use the provider's authenticated submission settings. TLS requires version 1.2+, OS trust and hostname verification; there is no insecure/plaintext fallback or custom-root environment switch. Restart the API after configuration changes. Links use the exact configured `FRONTEND_ORIGIN`; use the recipient-accessible HTTPS origin in production and localhost for local verification.

Accounts enroll explicitly through Account security → Send verification email using their current password. Existing accounts receive no trusted-email backfill or automatic mail. The link expires in 30 minutes; resending invalidates the prior link, with a 60-second cooldown and five issuances/hour/account. `/verify-email` removes its fragment immediately, requires the requesting account and current password, and never verifies on GET alone. Reload/navigation discards the private token; reopen the newest email. Verification preserves sessions; password changes revoke all sessions and invalidate pending proofs. Verified email changes and forgotten-password recovery follow the workflows below.

Delivery is synchronous after known database commit, with at most two concurrent batches, one or two messages/batch, 16 KiB/message and a two-second total SMTP deadline. `accepted` means SMTP accepted DATA, not inbox receipt. `unconfirmed` includes lost acknowledgements or mail failure; do not automatically resend or assume rollback. Notifications never undo credential changes. There is no retry queue/outbox; operators can see a safe warning with request ID, without recipient/token/provider response. Normal fixtures explicitly disable external SMTP, even when root `.env` has credentials; browser tests use an ephemeral trusted TLS peer and private pipes.

The opt-in [controlled-mailbox test](../../backend/internal/platform/integration/smtp_smoke_test.go) requires `ECOM_MAIL_TEST_RECIPIENT` in private `.env`. After explicitly loading private `.env` and the usual `ECOM_TEST_ADMIN_URL`/role passwords into the process, set `ECOM_SMTP_SMOKE=1` **in that process only** and run native `go test -tags=integration -count=1 -run '^TestControlledMailboxSMTP$' -v ./backend/internal/platform/integration`. Use the local toolchain/cache as in `scripts/dev.ps1`. This sends one verification message to the controlled mailbox, consumes its link through the authenticated API and removes its isolated account/database. Confirm actual receipt separately; its link is already consumed and requires no click. Never set the opt-in permanently or use customer recipients. A successful SMTP response alone does not satisfy the task's receipt gate.

M9 task 5 adds **Change email** to Account security and minimal `/confirm-email-change` links, using the same SMTP settings and schema 11. Restart an older API and rebuild the frontend; no new migration or service is needed. Verify the current email first, then submit a different proposed email with the current password. Confirm the links in both mailboxes, in either order, while signed in to the requesting account; each confirmation also requires its current password. The original login email stays active after the first proof. The second proof changes it, keeps it verified, invalidates other security proofs and revokes every session. Sign in deliberately with the new email and existing password; the account ID, cart and historical ownership are preserved. Both proven mailboxes receive best-effort completion notices.

Use **Refresh pending status** to observe current/proposed proof flags and request expiry. Replacing/resending deliberately creates a fresh request and two links, resets both proofs and invalidates both previous links. Limits remain five requests/hour/account and a 60-second cooldown, including cancelled/failed-delivery requests. Cancellation requires the exact current request ID/current password, invalidates its unused proofs and leaves credentials/sessions unchanged; it works with disabled SMTP. A foreign, expired or replaced request returns 404 without touching a newer request. Losing the current mailbox has no self-service bypass.

A proposed email is not reserved. Registration or another confirmation can claim it before the final proof; `409 email_conflict` closes the request while retaining the old email and sessions. A `security_outcome_unknown`, timeout or lost confirmation may mean the credential change committed: the browser hides private state and never repeats the write. Sign in deliberately with the proposed or current email, then read Account security before further action. Uncertain issuance/cancellation requires an explicit pending-status read. SMTP acceptance describes server acknowledgements, not inbox receipt; partial delivery may leave only one usable email. Wait before deliberately replacing that request. Failed completion notices never undo credentials or session revocation.

### Forgotten-password recovery

Use **Forgot your password?** on the login page or open `/forgot-password`. Only active accounts with a verified current email can recover. Accounts that never enrolled have no self-service bypass; verify from Account security while the current password is known. Valid admitted requests always return the same receipt after five seconds, including unknown/inactive/unverified addresses, suppression, lookup failures and uncertain delivery. The receipt does not promise an email. Disabled SMTP returns a service-wide 503; saturation of the 32 request slots returns 503/Retry-After 5. Peer admission is 20/minute; hashed-address suppression and persistent account issuance are three/hour. Limits are per process except durable issuance counts. Cancellation releases admission slots; work is bounded to four seconds, including the existing two-second SMTP budget.

Open the original `/reset-password#token=…` email link, enter a different new password twice and explicitly submit. Links expire after 15 minutes; up to three remain usable and requesting another does not invalidate an earlier link. Opening/reloading never resets a password. The page removes the fragment before routing and retains the proof only in tab memory; reload, navigation and identity changes discard it. Reopen the original email when needed. Passwords preserve whitespace and use the existing 15–128-character/512-byte bounds.

Successful reset atomically replaces the password, increments credential version, consumes/invalidates all security proofs, cancels pending email changes and revokes every target session. Sign in normally with the new password; there is no automatic login. Completion notification is best effort and never rolls back the reset. These public endpoints omit cookies/bearer credentials and never set/clear cookies. After confirmed success, tabs hide private state and coordinate one cookie/profile check: an unrelated account can restore, while revoked target sessions are rejected. A revoked cookie remains harmless until login replaces it or explicit logout clears it. A lost reply/503 may mean the reset committed: discard the link/passwords and deliberately sign in or check the session; never automatically resubmit. No new migration, SMTP setting, dependency, queue or tooling container is needed; restart the API and rebuild the frontend to expose the new routes.

Security history pruning is an explicit owner/migrator operation, never API runtime work. Retain tokens/requests until at least seven days after expiry. Execute each statement as its own committed transaction; repeat deliberately while rows are removed. Delete tokens before requests, and retain requests still referenced by any token. Each batch removes at most 500 rows; do not wrap a repetition loop in one transaction.

```sql
DELETE FROM account_security_tokens WHERE id IN (
 SELECT id FROM account_security_tokens
 WHERE expires_at < clock_timestamp() - interval '7 days'
 ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED
);
```

```sql
DELETE FROM email_change_requests WHERE id IN (
 SELECT r.id FROM email_change_requests r
 WHERE r.expires_at < clock_timestamp() - interval '7 days'
 AND NOT EXISTS (SELECT 1 FROM account_security_tokens t WHERE t.change_request_id=r.id)
 ORDER BY r.expires_at,r.id LIMIT 500 FOR UPDATE SKIP LOCKED
);
```

## First setup and routine restart

Check `go version`, `goose -version`, `sqlc version` and `docker compose version`. Start Docker Desktop's Linux engine and ensure `postgres:16-alpine` is already downloaded: the database script uses `--pull never`. Bash setup also needs OpenSSL; race tests need a working C compiler. Native Linux/macOS execution is not yet verified.

| Step | PowerShell | Bash | Expected result / safe rerun |
|---|---|---|---|
| Create local configuration, once | `./scripts/dev.ps1 init-env` | `bash scripts/dev.sh init-env` | Creates ignored `.env` with independent random secrets; refuses to overwrite an existing file |
| Start PostgreSQL | `./scripts/dev.ps1 database` | `bash scripts/dev.sh database` | Starts/waits for the existing Compose service; preserves `ecom_postgres_data` |
| Inspect migrations | `./scripts/dev.ps1 status` | `bash scripts/dev.sh status` | Shows goose migration status/current version using migration credentials; does not apply domain migrations |
| Apply approved migrations | `./scripts/dev.ps1 migrate` | `bash scripts/dev.sh migrate` | Applies pending files in order; rerun is a no-op when already at version 11 |
| Confirm current schema | `./scripts/dev.ps1 status` | `bash scripts/dev.sh status` | All eleven migrations applied; current version 11 |
| Run API in its own terminal | `./scripts/dev.ps1 run` | `bash scripts/dev.sh run` | Listens on configured loopback address; Ctrl+C requests graceful shutdown |

For routine restarts, reuse `.env` and start the database/API as needed. Apply migrations only when code/schema changes require them. Neither API nor recovery migrates automatically. Never run `init-env` over an existing configuration or delete the database volume to solve a startup problem.

M9 security work requires migrations 10–11 before restarting the updated API. They add internal credential versioning, unverified email state and security proof/request storage with scoped grants, without changing existing passwords/sessions. A password change deliberately revokes every session; email verification preserves sessions. Local SMTP is optional for shopping/password changes but required for verification. See the configuration section above.

The status action uses goose's normal metadata handling: on an uninitialized database goose may create its metadata table. It is an inspection by the migration owner, not a strict read-only diagnostic. Use recovery dry-run for read-only application diagnostics after migrations.

## Configuration and credentials

For a fresh demonstration/browser-test dataset, use the separate [fixture workflow](../frontend/FIXTURES.md). It creates a new owned database, applies local goose migrations and writes ignored per-run credentials; it does not seed or reset the ordinary development database. `fixture-run` selects its runtime-only environment instead of the ordinary `run` target. Fixture removal validates local server/owner/marker before touching that isolated database.

The scripts parse root `.env` as literal `KEY=value`; they do not evaluate shell expressions. `.env` entries override matching inherited variables in the script process. Keep the file private and out of source control. Never run shell tracing, print the resolved Compose configuration, or dump environment variables to shared logs. Use `docker compose config --quiet` for configuration validation.

| Setting | Used by / behavior |
|---|---|
| `APP_ENV` | Both binaries: `local` or `production`; scripts are intended for the local loopback database |
| `HTTP_ADDR` | API only; defaults to `127.0.0.1:8080`; local mode requires loopback |
| `FRONTEND_ORIGIN` | API browser allowlist; local default `http://localhost:5173`; production requires explicit HTTPS origin |
| `JWT_SECRET_BASE64` | API only; base64 encoding of at least 32 random bytes; `init-env` generates it |
| `POSTGRES_PORT` | Scripts/Compose; host port 1–65535, default 5432; change before starting if occupied |
| `POSTGRES_PASSWORD` | Database bootstrap and disposable-test administrator; never used by the API |
| `MIGRATOR_PASSWORD` | Bootstrap, goose status/migrate, and deliberate operator maintenance through `ecom_migrator` |
| `APP_DB_PASSWORD` | Bootstrap and runtime `ecom_app` URL for API/recovery |
| `DATABASE_URL` | Direct binary execution only; scripts construct/replace it for the local database using the appropriate login |
| `GOOSE_DRIVER`, `GOOSE_DBSTRING` | Status/migrate scripts set these for local goose; credentials stay out of command arguments |

Direct `go run ./backend/cmd/api` needs process `APP_ENV`, `DATABASE_URL`, `JWT_SECRET_BASE64` and production's explicit frontend origin. Direct recovery needs only `APP_ENV`/`DATABASE_URL`. Binaries do not load `.env`. For nonlocal execution supply process configuration directly; local scripts always construct a loopback URL with `sslmode=disable`. Production requires `sslmode=verify-full`, Secure cookies and verified HTTPS delivery; the current HTTP listener does not provide TLS by setting `APP_ENV` alone.

Bootstrap runs only when PostgreSQL initializes an empty data directory. Editing passwords in `.env` does not change existing database roles. Rotate actual role passwords deliberately using an authorized operator connection, update the matching private configuration, and restart affected processes. Do not use volume deletion as password rotation. Changing the JWT secret invalidates existing access-token signatures; it does not delete stored sessions.

## Migrations, generation and verification

Schema authority is [backend/migrations](../../backend/migrations), currently version 11 with 15 domain tables plus goose metadata. Migrations 1–5 create the schema, 6–9 grant scoped writes, 10 adds internal credential versioning, and 11 adds verification state and token/pending-email tables plus scoped grants. Inspect status before applying changes and confirm readiness afterward. If a migration fails, stop and inspect its transaction/result/status; do not edit goose metadata to force success. Existing version 11 is expected, not an instruction to run down migrations against development data.

| Purpose | PowerShell | Bash |
|---|---|---|
| Generate typed queries after SQL changes | `./scripts/dev.ps1 generate` | `bash scripts/dev.sh generate` |
| Formatting, sqlc, goose validation, vet and unit checks | `./scripts/dev.ps1 check` | `bash scripts/dev.sh check` |
| Native unit tests | `./scripts/dev.ps1 test` | `bash scripts/dev.sh test` |
| PostgreSQL integration tests | `./scripts/dev.ps1 integration` | `bash scripts/dev.sh integration` |
| Integration with race detector | `./scripts/dev.ps1 integration -Race` | `bash scripts/dev.sh integration --race` |

`check` regenerates sqlc output and fails if it changes; review/retain intended generated changes rather than suppressing the failure. Integration tests require the bootstrap roles and create/drop only their own random `ecom_foundation_*` databases. They never reset the configured development database; down/reapply checks run only in those disposable databases. A failed cleanup can leave a test database for investigation; never run a wildcard cleanup against other databases. Record actual verification separately from commands described here.

## Health and safe observability

With the API running, inspect `http://127.0.0.1:8080/health/live` and `/health/ready` using `Invoke-WebRequest` or a browser. Adjust the URL if `HTTP_ADDR` changed. Expected status is 200 for both after migrations; liveness remains 200 during a database outage while readiness becomes 503. Readiness checks connectivity/version 11, not every privilege or cross-row invariant.

The API writes structured logs to stdout: request ID, method, status and duration, without raw URLs, bodies, passwords or addresses. `/metrics` is a root route requiring an active administrator bearer token; it exposes a process-local authenticated-request counter. Anonymous requests receive 401 and customers 403. Keep access tokens in memory when inspecting it; never put them in URLs or committed scripts. Logs/counters are not a durable audit of every committed database transaction.

For future browser use, keep API/frontend browser hostnames consistent (`localhost` on both by default), the exact origin allowlist and credentialed auth requests. Shell health checks using `127.0.0.1` do not establish browser cookie compatibility. The [integration audit](../frontend/API_INTEGRATION.md#browser-session-and-http-rules) owns those details.

## Provision an administrator

No account is seeded or automatically promoted. Register an ordinary customer through the API, then deliberately select its returned UUID and confirm the account identity. Use a trusted PostgreSQL SQL session as `ecom_migrator` against database `ecom`; connection host/port and password come from the private local configuration. Bind `$1` below as a UUID through the client's parameter facility. A client with parameter binding is required for manual SQL; the repository does not install or assume a local `psql` binary, and no SQL tool is run in Docker.

First inspect the selected account:

```sql
SELECT id, email, role, is_active FROM users WHERE id = $1;
```

Confirm the expected email and active customer role. In an explicit transaction, execute this parameterized statement with that same UUID:

```sql
UPDATE users SET role = 'admin', updated_at = now()
WHERE id = $1 AND role = 'customer' AND is_active
RETURNING id, email, role;
```

Commit only after exactly one expected row is returned. Zero rows means missing, inactive or already promoted: inspect the row rather than broadening the WHERE clause. Roll back on errors or an unexpected identity/result. Re-read by UUID after commit. If the connection is lost at commit, reconnect and inspect that same account before deciding whether to retry. Rerunning the guarded UPDATE does not promote other users or rewrite an already-admin row.

Verify `GET /api/v1/users/me` reports admin and `GET /metrics` returns 200 using that account's authenticated session. Current database role checks take effect on subsequent requests; already-authorized in-flight work is not cancelled. An unexpired access JWT need not be reissued just for the role change. Customer access must still receive 403. Runtime credentials cannot execute this promotion; keep privileged credentials out of the API/browser. There is no public role endpoint, browser role editor or default administrator password.

## Inspect and recover interrupted orders

Start with `./scripts/dev.ps1 reconcile -Limit 100` or `bash scripts/dev.sh reconcile --dry-run --limit 100`. Both use runtime credentials and are read-only. Review `diagnostic_count`, bounded examples and candidate states before intentionally using `-Apply` / `--apply` for recovery. Full flags, events, limits, exit behavior and rerun rules are in [RECOVERY.md](RECOVERY.md).

Reservation expiry is creation plus 15 minutes, not automatic release. Only explicit apply or eligible customer cancellation changes holds. Recovery derives the existing attempt's persisted scenario and reuses settlement; it never changes scenarios, creates new attempts or repairs corrupt counters. An error or missing summary does not prove rollback. Re-inspect after fixing infrastructure issues; if corruption is reported, investigate it rather than editing counters/statuses to silence diagnostics.

## Account and cart browser behavior

Use the [frontend commands](../../frontend/README.md) and [acceptance mapping](../frontend/TEST_PLAN.md#milestone-9-acceptance) for local account/security/address/cart checks. No new environment variable, migration or delivery service is required by M9 acceptance. Verification/recovery still require configured SMTP; shopping/password changes remain available without it. The existing shared limit admits five authenticated security actions per user per minute: a legitimate sequence can hit 429, which requires waiting and an explicit retry rather than repeatedly submitting proofs.

An unknown/updating cart badge does not mean an empty cart. After an unconfirmed mutation, use explicit Reload cart/review before another change; navigation, foreground checks and peer notices never repeat the write or silently clear uncertainty. Ordinary unchanged observations retain quantity drafts; explicit reload replaces them. Prices are estimates from the last product-detail load; Retry product details refreshes them, and checkout will remain authoritative.

`cart_version_exhausted` rejects further mutations while reads remain available. Preserve the cart/version and investigate; do not decrement versions or rewrite inventory/reservations to force a request through. Tests exercise this boundary only in marker-owned fixtures through a compiled integration test, without a production control endpoint. Final deployment/packaged browser checks remain the release milestone.

## Troubleshooting and stopping

| Symptom | Check / next action |
|---|---|
| Docker pipe unavailable/denied | Confirm Docker Desktop's Linux engine and local access permissions; a stopped engine is distinct from a sandbox permission failure |
| Database image missing | Download the approved `postgres:16-alpine` explicitly; the script intentionally does not pull it |
| Port already in use | Inspect the configured loopback port; stop only the intended conflicting process or select another port consistently |
| Database authentication failure | Verify the actual role/password matches the private configuration; existing-volume passwords do not change when `.env` changes |
| Live 200, ready 503 | Check database reachability, runtime credentials and goose status/version 11; apply approved pending migrations explicitly |
| Forbidden browser auth | Check exact Origin, CSRF header, credentialed requests and matching cookie host/site settings; do not weaken the allowlist |
| Recovery nonzero/missing summary | Inspect stderr and any completed events, then dry-run current state; do not infer rollback or release stock manually |

Ctrl+C stops the API with its ten-second shutdown budget. `docker compose stop postgres` stops the database while retaining its container/volume; `docker compose down` removes project containers/network but retains the named volume. Start the same database with the database action. Do not add `-v`, reset roles, or apply destructive down migrations to persistent development data. Production backup/restore and final packaged deployment verification are not claimed by this local guide.
