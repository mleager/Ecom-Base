# Operations runbook

Operator tasks for the backend. Run commands from the repository root. Setup and daily development commands are in [HOW_TO.md](../../HOW_TO.md); the AWS stack is in [infrastructure/terraform/README.md](../../infrastructure/terraform/README.md).

## Principles

- **Nothing happens automatically that an operator can't see.** The API never migrates, cleans up or recovers orders by itself. Each of those is a separate command with JSON-lines output and a meaningful exit code. On AWS, the same commands run as scheduled or one-off ECS tasks.
- **Every command is safe to rerun.** Migrations take an advisory lock; recovery and cleanup work in small committed batches.
- **Secrets come only from the environment.** The binaries never read `.env`, and no command prints a database URL. Never print `.env` files or dump the Compose config; use `docker compose config --quiet`.

## Configuration

| Mode | Enforced at startup |
|---|---|
| `local` | Loopback listener; the database may skip TLS only on loopback; TLS and `Secure` cookies optional |
| `production` | HTTPS `FRONTEND_ORIGIN`, `sslmode=verify-full`, TLS certificate and key, `MAIL_MODE=smtp`; `Secure` cookies and HSTS |

The required settings are `APP_ENV`, `DATABASE_URL` and `JWT_SECRET_BASE64`. `STATIC_DIR` serves the built SPA from the same origin. Behind CloudFront, set `TRUSTED_PROXY=cloudfront` and `RATE_LIMIT_STORE=postgres`. Size the pool (`pool_max_conns` in the URL, default 10) against `max_connections` across every API task.

### Telemetry

Telemetry is off unless configured. `METRICS_ADDR` (`host:port`) opens a plain-HTTP Prometheus listener, which must never be routed from a load balancer or CDN. `OTEL_EXPORTER_OTLP_ENDPOINT` turns on trace export. Everything emitted is listed in [OBSERVABILITY.md](OBSERVABILITY.md).

To see exactly what leaves the process, run the pinned debug Collector against the Compose deployment:

```bash
docker compose -f compose.deploy.yaml -f compose.deploy.telemetry.yaml --profile telemetry up -d --wait
docker compose -f compose.deploy.yaml --profile telemetry logs collector
```

## Migrations

```bash
docker compose -f compose.deploy.yaml run --rm migrate migrate status   # read-only
docker compose -f compose.deploy.yaml run --rm migrate migrate up
```

Locally, `bash scripts/dev.sh migrate` and `status` use the goose CLI on the development database. `migrate` prints one JSON line per migration and then a summary (`version`, `latest`, `minimum`, `ready`). A second run waits for the advisory lock (up to 10 minutes) and then applies whatever is left, usually nothing. A failed migration rolls back only itself and exits 1; fix it with a new forward migration. An older build against a newer schema applies nothing and exits 0.

## Compose deployment (single host)

[`compose.deploy.yaml`](../../compose.deploy.yaml) runs the release image the way it is deployed: production mode, TLS everywhere, its own volume, and Mailpit capturing all mail. The order is `certs` → `postgres` (healthy) → `migrate` (must exit 0) → `api`, so a failed migration keeps the API from starting.

```bash
bash scripts/certs.sh                 # local CA and certificates (once)
bash scripts/dev.sh init-deploy-env   # .env.postgres, .env.migrate, .env.deploy (0600, new secrets)
bash scripts/dev.sh deploy            # build and start; app on https://localhost:8443, mail on :8025
ECOM_IMAGE=ecom-base:1.0.0 bash scripts/dev.sh deploy   # run a release image without rebuilding
bash scripts/dev.sh deploy-verify     # throwaway project: 10 checks, then removes its volumes
```

`deploy-verify` checks the following, then removes its project and volumes:

- an empty-volume start and the migration summary
- HTTPS readiness
- the database role defaults, and that the superuser is refused over TCP
- a headless browser journey with captured mail
- `reconcile` on a deliberately stranded order
- a full restart
- telemetry off, then on

## Recover interrupted orders

```bash
bash scripts/dev.sh reconcile --dry-run --limit 100   # read-only, the default
bash scripts/dev.sh reconcile --apply --limit 100
```

Eligible orders are still `pending_payment` after their 15-minute reservation deadline. Apply claims each with `FOR UPDATE SKIP LOCKED` and settles it through the normal T2, so concurrent operators are safe. Budgets are 2 minutes per run and 5 s per order. Output is one JSON event per order, then a summary with diagnostics:

| Event | Meaning |
|---|---|
| `candidate` | Dry-run found a valid eligible order |
| `claimed` / `resumed` | Apply claimed an order, or picked up one already processing |
| `settled` / `already_terminal` | A terminal result was reached or found |
| `inconsistent` | Unsafe state was refused; nothing was repaired |
| `failed` / `uncertain` | The operation failed, or its commit outcome is unknown |

A non-zero exit means bad flags, inconsistent data, failures or unresolved outcomes; rerunning is always safe. **Never** release stock or edit counters by hand. On AWS, `reconcile --apply` runs every 5 minutes, and a non-zero exit sends an SNS alert.

## Remove expired guest data

```bash
bash scripts/dev.sh maintain guests                    # batches until one changes nothing
bash scripts/dev.sh maintain guests --max-batches 1
```

`maintain guests` runs as the migrator; its SQL refuses any other role. Each batch is one transaction of at most 500 rows per table, with a 5-second deadline. It removes the following:

- guests whose sessions expired at least 7 days ago, unless they have an order or checkout intent
- expired checkout intents, which are scrubbed to tombstones
- recovery proofs and grants 7 days after they expire

Expired account security tokens are pruned the same way with operator SQL as `ecom_migrator`: batches of 500, `FOR UPDATE SKIP LOCKED`, at least 7 days after expiry.

## Provision an administrator

No account is promoted automatically. As `ecom_migrator`, in an explicit transaction, bind `$1` to the user's UUID:

```sql
UPDATE users SET role = 'admin', updated_at = now()
WHERE id = $1 AND role = 'customer' AND is_active
RETURNING id, email, role;
```

Commit only if exactly the expected row comes back. The change applies on the user's next request.

## Email

`MAIL_MODE=disabled` is the local default: shopping works, but verification, email change and password reset return 503. `MAIL_MODE=smtp` needs `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_MODE` (`starttls` or `tls`), `SMTP_USERNAME`, `SMTP_PASSWORD` and `MAIL_FROM`. SMTP acceptance does not prove delivery to an inbox.

## Troubleshooting

| Symptom | Action |
|---|---|
| `live` 200, `ready` 503 | Check database reachability, the runtime credentials, and that `migrate status` shows at least version 16 |
| Database authentication fails | Role passwords were fixed when the volume was created; editing `.env` doesn't change them |
| Browser writes return 403 | Check the exact Origin, the `X-CSRF-Protection` header and credentialed fetch |
| Most routes return 500 `internal_error` | The database is unreachable; tasks stay up and recover when it returns. Readiness reports it |
| `WARN security email delivery unconfirmed` | SMTP failed or exceeded its 2 s budget; the user can resend. Test the server outside the API |
| `WARN refresh token reuse revoked a session` | An old refresh token was presented after the 30-second grace; treat it as a possibly stolen cookie |
| `localhost` dev pages redirect to HTTPS | A production-mode run sent HSTS for `localhost`; clear it in the browser |
| `409 cart_version_exhausted` | Investigate; never decrement versions or edit inventory to force a request through |
