# Operations

Operator tasks for the local backend. Basic setup and daily commands are in [../DEVELOPMENT.md](../DEVELOPMENT.md). Run everything from the repository root.

## Configuration rules

- The scripts read `.env` as literal `KEY=value` lines (no quotes, no expansion). Values in `.env` override inherited variables.
- The binaries do **not** read `.env`. Running a binary directly requires `APP_ENV`, `DATABASE_URL` and `JWT_SECRET_BASE64` to be set in the process (plus `FRONTEND_ORIGIN`, `TLS_CERT_FILE` and `TLS_KEY_FILE` in production). The recovery CLI needs only `APP_ENV` and `DATABASE_URL`.
- Never print `.env`, run with shell tracing, or dump the Compose config. Use `docker compose config --quiet`.
- Changing `JWT_SECRET_BASE64` invalidates existing access tokens but leaves stored sessions in place.

| Mode | Requirements enforced at startup |
|---|---|
| `local` | `HTTP_ADDR` must be loopback. The database may use `sslmode=disable` only on loopback. TLS is optional. Cookies are `Secure` only when TLS is on. No HSTS. |
| `production` | `FRONTEND_ORIGIN` must be HTTPS. `DATABASE_URL` must use `sslmode=verify-full`. `MAIL_MODE=smtp`. TLS is required. Cookies are `Secure`, and every response carries `Strict-Transport-Security: max-age=31536000`. |

TLS is on when `TLS_CERT_FILE` and `TLS_KEY_FILE` are both set; setting only one is a startup error. The pair is loaded before the listener starts, so an unreadable or mismatched pair also fails at startup. The listener accepts TLS 1.2 and newer, and negotiates HTTP/2. Server messages such as failed TLS handshakes are logged as JSON at `WARN`.

## Migrations

```bash
bash scripts/dev.sh status      # inspect (goose may create its metadata table on a new database)
bash scripts/dev.sh migrate     # apply pending migrations
bash scripts/dev.sh status      # expect version 13
```

The API never migrates on its own. Readiness stays 503 until the schema is exactly version 13. If a migration fails, stop and inspect it. Never edit goose metadata or run down-migrations on data you want to keep.

## Provision an administrator

No account is seeded or promoted automatically. Promote a registered, active customer with a parameterized SQL session as `ecom_migrator` on database `ecom`. Bind `$1` as the user's UUID.

```sql
-- 1. Inspect
SELECT id, email, role, is_active FROM users WHERE id = $1;

-- 2. In an explicit transaction
UPDATE users SET role = 'admin', updated_at = now()
WHERE id = $1 AND role = 'customer' AND is_active
RETURNING id, email, role;
```

Commit only if exactly the expected row comes back. Zero rows means the user is missing, inactive or already an admin; inspect the row instead of widening the `WHERE` clause. To verify, `GET /api/v1/users/me` should show `admin` and `GET /metrics` should return 200. The change applies on the next request.

`scripts/connect.sh` opens `psql` inside the PostgreSQL container (`connect.sh fix` targets the current fixture database; it needs `jq`). Check which role it connects as before running the UPDATE. Keep credentials out of shell history and shared logs.

## Recover interrupted orders

```bash
bash scripts/dev.sh reconcile --dry-run --limit 100   # read-only (also the default)
bash scripts/dev.sh reconcile --apply --limit 100     # perform recovery
```

- **Eligible orders:** still `pending_payment` with `reservation_expires_at <= cutoff`. One database cutoff per run; ordered by deadline, then ID.
- **Limit:** 1–1000 (default 100). Every visited candidate counts toward it, including failures.
- **Dry-run** reads candidates and diagnostics from one `REPEATABLE READ READ ONLY` snapshot and changes nothing.
- **Apply** selects each order with `FOR UPDATE SKIP LOCKED`. It commits the processing claim before simulating, then settles through the normal T2. Concurrent operators are safe.
- **Budgets:** 2 minutes per run, 5 s per candidate, 1 s to resolve a commit.
- **Never:** changes the payment scenario, creates a new attempt, force-cancels, releases stock because of expiry, or repairs corrupt counters.

Output is JSON Lines: one event per candidate, then a `summary`.

| Event | Meaning |
|---|---|
| `candidate` | Dry-run found a valid eligible order |
| `claimed` / `resumed` | Apply committed a claim, or picked up an existing `processing` attempt |
| `settled` | A valid terminal result was observed |
| `already_terminal` | A lost acknowledgement resolved to a terminal order |
| `inconsistent` | Validation refused unsafe state; nothing was repaired |
| `failed` / `uncertain` | The operation failed, or its commit outcome is unknown |

The summary includes counters, `diagnostic_count` and up to 100 `diagnostic_findings`. Diagnostics check reserved counters against active reservations, reservation links, order totals and deadlines, and payment-attempt consistency.

**Exit code:** 0 means the run was healthy. A nonzero code means bad flags or config, inconsistent data, failures, unresolved outcomes or interruption. A 0 exit does not mean all eligible orders were processed, because limits and skipped locks still apply. Rerunning is always safe.

## Email (SMTP)

`MAIL_MODE=disabled` is the local default and requires the SMTP fields to be blank. Shopping and password changes still work; verification, email change and password reset return 503.

For `MAIL_MODE=smtp`, set every field: `SMTP_HOST` (host name only), `SMTP_PORT`, `SMTP_TLS_MODE` (`starttls` or `tls`), `SMTP_USERNAME`, `SMTP_PASSWORD`, and `MAIL_FROM` (a single ASCII address). Restart the API after changes. `FRONTEND_ORIGIN` must be an address the recipient can open.

**Controlled mailbox test (opt-in):** sends one real verification email to a mailbox you own, consumes the link through the API, and cleans up after itself. It needs `ECOM_MAIL_TEST_RECIPIENT` in `.env`, plus `ECOM_SMTP_SMOKE=1` and the usual integration variables (`ECOM_TEST_ADMIN_URL`, `ECOM_TEST_MIGRATOR_PASSWORD`, `ECOM_TEST_APP_PASSWORD`) set **in that one process only**:

```bash
go test -tags=integration -count=1 -run '^TestControlledMailboxSMTP$' -v ./backend/internal/platform/integration
```

Check the inbox yourself. SMTP acceptance does not prove delivery. Never leave `ECOM_SMTP_SMOKE` set permanently, and never use a customer's address.

## Pruning

Run as `ecom_migrator`. Each statement is its own committed transaction; repeat it while rows are still being deleted. Delete tokens before requests.

```sql
DELETE FROM account_security_tokens WHERE id IN (
  SELECT id FROM account_security_tokens
  WHERE expires_at < clock_timestamp() - interval '7 days'
  ORDER BY expires_at, id LIMIT 500 FOR UPDATE SKIP LOCKED
);

DELETE FROM email_change_requests WHERE id IN (
  SELECT r.id FROM email_change_requests r
  WHERE r.expires_at < clock_timestamp() - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM account_security_tokens t WHERE t.change_request_id = r.id)
  ORDER BY r.expires_at, r.id LIMIT 500 FOR UPDATE SKIP LOCKED
);
```

Guest sessions, proofs and grants follow the same pattern: at least 7 days after expiry, 500-row batches, 5 s per transaction. See [GUEST_COMMERCE.md](GUEST_COMMERCE.md#maintenance).

## Cart version exhaustion

`409 cart_version_exhausted` blocks further writes to that cart; reads still work. Investigate the cause. Never decrement versions or edit inventory to force a request through.

## Troubleshooting

| Symptom | Action |
|---|---|
| `live` 200, `ready` 503 | Check database reachability, runtime credentials and `status` = 13 |
| Database authentication fails | Passwords were fixed when the volume was created; editing `.env` does not change them |
| Browser auth returns 403 | Check the exact Origin, the CSRF header, credentialed fetch, and matching host names |
| Recovery exits nonzero or has no summary | Read stderr and the completed events, then dry-run again. Do not assume a rollback or release stock by hand. |
| Image missing | `docker pull postgres:16-alpine`; the script never pulls |

Stop the API with Ctrl+C (10 s graceful shutdown). Stop the database with `docker compose stop postgres`. Never reset the volume to fix a startup problem.

Production backup and restore are not covered.
