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

`STATIC_DIR` (optional, either mode) serves a built frontend from the API origin. A relative path resolves from the process working directory (the repository root for `scripts/dev.sh run`). Startup fails if the directory is unreadable or has no `index.html`. Routing and cache rules: [ARCHITECTURE.md](ARCHITECTURE.md#static-frontend-optional).

The pool holds at most 10 connections and keeps none open when idle. pgx's `pool_max_conns` and `pool_min_conns` URL parameters change that (for example `&pool_max_conns=20`); a minimum above the maximum fails startup. pgx's other `pool_*` parameters, such as `pool_max_conn_lifetime`, are honored too. Size the pool against PostgreSQL's `max_connections` across every API process.

A production `DATABASE_URL` looks like `postgresql://ecom_app:<password>@<db-host>/ecom?sslmode=verify-full&sslrootcert=<path to the CA certificate>`. The certificate must name `<db-host>`. Locally, `bash scripts/dev.sh database-tls` provides such a server; see [DEVELOPMENT.md](../DEVELOPMENT.md#database-tls).

### Production mode on one host

No script starts production mode; set the variables in the API process yourself. This is how the M14 production smoke ran ([STATUS.md](../STATUS.md#production-mode-smoke-m14-task-9-2026-11-07)):

1. `bash scripts/certs.sh`, then `bash scripts/dev.sh database-tls`.
2. `cd frontend && npm run build:same-origin`.
3. Build the API (`go build -o <path> ./backend/cmd/api`) and start it with `APP_ENV=production`, `HTTP_ADDR=127.0.0.1:8443`, `FRONTEND_ORIGIN=https://localhost:8443`, `TLS_CERT_FILE=.cache/certs/server.pem`, `TLS_KEY_FILE=.cache/certs/server.key`, `STATIC_DIR=frontend/dist`, a `verify-full` `DATABASE_URL` with host `localhost`, `JWT_SECRET_BASE64`, and every SMTP field with `MAIL_MODE=smtp`.
4. Check `curl --cacert .cache/certs/ca.pem https://localhost:8443/health/ready`.

Production mode sends HSTS for `localhost`. A desktop browser that stores it may then force HTTPS on every `localhost` port, which breaks the Vite dev server on 5173. Use a private window or a headless browser, or remove the entry afterwards (Chromium: `chrome://net-internals/#hsts`, delete domain `localhost`). The local `serve-https` mode never sends HSTS.

### Telemetry (optional)

Off unless configured (Milestone 15). With nothing set the API opens no extra listener, makes no outbound connection and logs exactly as before.

| Variable | Effect |
|---|---|
| `METRICS_ADDR` | `host:port` of an internal plain-HTTP listener serving Prometheus metrics at `GET /metrics` (no authentication). Local mode requires a loopback host; production allows any host. Its port must differ from `HTTP_ADDR`'s. A busy port fails startup. Do not route a load balancer or CDN to it. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Turns on trace export over OTLP/HTTP (for example `http://localhost:4318`). |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Override the default `service.name` of `ecom-api`. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_TRACES_SAMPLER`, `OTEL_BSP_*` | Standard SDK settings, read by the SDK. |
| `OTEL_SDK_DISABLED=true` | Turns off traces and the metrics listener. |

`TRACE_TRUST_UPSTREAM=true` continues incoming `traceparent` headers; leave it unset behind CloudFront or any proxy that forwards client headers (M17 task 11). `OTEL_TRACES_EXPORTER` accepts only `otlp` or `none`, and the OTLP protocol variables only `http/protobuf`; other values fail startup. Startup logs one `telemetry configured` line when anything is on. With traces on, request logs also carry `trace_id` and `span_id`; health probes and `/metrics` are never traced. An unreachable Collector never delays requests: spans are dropped when the queue is full, failures are logged at `WARN` at most once a minute, and shutdown stops flushing at its 10 s deadline. Design: [MILESTONE_15.md](../MILESTONE_15.md) and [DECISIONS.md](../DECISIONS.md#observability-milestone-15).

Every span, metric, label and log field the API emits is listed in [OBSERVABILITY_CONTRACT.md](OBSERVABILITY_CONTRACT.md).

#### Telemetry export check

A pinned OpenTelemetry Collector with only the `debug` exporter shows what leaves the process. `scripts/telemetry-check/collector.yaml` receives spans over OTLP/HTTP on `127.0.0.1:4318`, scrapes `127.0.0.1:9464` every 5 s, and prints both. It stores nothing. From the repository root:

```bash
docker run -d --name ecom-otel-check --network host \
  -v "$PWD/scripts/telemetry-check/collector.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector:0.164.0@sha256:28b6d41ac51bff6b41ba5e8fe503569ffb9d6a1ea90f7a78419e86f34e44f750
bash scripts/fixture.sh create --https
METRICS_ADDR=127.0.0.1:9464 OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  bash scripts/fixture.sh serve <fixture-name>
```

Use the app at `https://localhost:8443`, then read `docker logs ecom-otel-check`: each request is a `Span` block under its `{method} {route}` server span, and each scrape lists the metric families. `--network host` lets the container reach the API's loopback listeners (Linux only). Clean up with `docker rm -f ecom-otel-check` and `bash scripts/fixture.sh remove <fixture-name>`. The fixture sets `MAIL_MODE=disabled`, so no `smtp send` spans appear; those are covered by tests. The M15 run is recorded in [STATUS.md](../STATUS.md#telemetry-export-check-and-overhead-m15-task-6-2026-11-09).

## Migrations

```bash
bash scripts/dev.sh status      # inspect (goose may create its metadata table on a new database)
bash scripts/dev.sh migrate     # apply pending migrations
bash scripts/dev.sh status      # expect version 13
```

The API never migrates on its own. Readiness stays 503 while the schema is older than version 13; newer versions pass. If a migration fails, stop and inspect it. Never edit goose metadata or run down-migrations on data you want to keep.

### Release migration job (`cmd/migrate`)

Deployments use the `migrate` binary from the application image instead of the goose CLI. It carries the SQL it was built with and only moves forward.

```bash
go build -o bin/migrate ./backend/cmd/migrate
APP_ENV=local DATABASE_URL='<ecom_migrator URL>' bin/migrate status   # read-only
APP_ENV=local DATABASE_URL='<ecom_migrator URL>' bin/migrate up
```

- **Settings:** `APP_ENV` and `DATABASE_URL` only, with the API's URL rules (`sslmode=verify-full` except local loopback). Use the `ecom_migrator` credentials; the API keeps `ecom_app`. It never reads `.env` and never prints the URL.
- **Output:** JSON lines. `up` prints `applied` per migration, `failed` with the SQLSTATE and message, then a `summary` with `version`, `latest` (newest in this build), `minimum`, `applied`, `pending` and `ready`. `status` prints a `migration` line per version (`applied`, `pending`, or `unknown` when the database is newer than the build) and a summary.
- **Locking:** `up` holds a PostgreSQL session advisory lock (goose's default ID). A second run waits, polling each second for up to 10 minutes, then applies whatever is still pending, usually nothing.
- **Failure:** each migration runs in its own transaction, so a failure rolls that migration back, keeps the earlier ones, and exits 1 with `migration N failed; schema version is M`. Fix it with a new forward migration. `lock_timeout` is 10 s unless the URL sets it, so a migration stuck behind a long transaction fails instead of blocking traffic.
- **Older build, newer schema:** `up` applies nothing and exits 0; `status` lists the newer versions as `unknown`.

## Application image

The root [`Dockerfile`](../../../Dockerfile) builds one image with `api`, `migrate`, `reconcile`, `maintain` (M17 task 8) and `db-bootstrap` (M17) in `/usr/local/bin` and the same-origin SPA in `/app/dist` (`STATIC_DIR` is preset). It runs as user 65532, has no shell, and holds no secrets or private certificates; the only certificate file is the public Amazon RDS CA bundle at `/etc/ssl/rds/global-bundle.pem`, pinned by checksum, which AWS deployments use as `sslrootcert`.

```bash
docker build --build-arg VERSION=<version> --build-arg REVISION="$(git rev-parse HEAD)" -t ecom:<version> .
docker image inspect ecom:<version> --format '{{json .Config.Labels}}'
```

- **Run a binary:** the default command is `api`; name another to run it, for example `docker run --rm --env-file <migrator env file> ecom:<version> migrate status`.
- **Settings** come only from the environment (`--env-file` with mode 0600, never `-e` with a secret on the command line). `bash scripts/dev.sh init-deploy-env` creates `.env.postgres`, `.env.migrate` and `.env.deploy` for the Compose deployment profile. Mount certificates read-only and point `TLS_CERT_FILE` / `TLS_KEY_FILE` and the `sslrootcert` URL parameter at them.
- **Local mode** binds only to loopback, which a published port cannot reach; for a quick local check use `--network host` (Linux) with `HTTP_ADDR=127.0.0.1:<port>`. Published deployments run in production mode (task 4).
- **Base images** are pinned by digest in the `Dockerfile`; DECISIONS.md records each choice and its date.
- **Release build:** `bash scripts/release-evidence.sh <version>` builds `ecom:<version>` from the committed tree only and prints the evidence recorded in [RELEASE.md](../RELEASE.md).

## Deployment profile

[`compose.deploy.yaml`](../../../compose.deploy.yaml) runs the image the way it is deployed, on this machine: production mode, TLS everywhere, its own database volume (project `ecom-deploy`), and Mailpit capturing all mail.

```bash
bash scripts/certs.sh                 # local CA, server, postgres and mail certificates
bash scripts/dev.sh init-deploy-env   # .env.postgres, .env.migrate, .env.deploy (0600, new secrets)
bash scripts/dev.sh deploy            # docker compose up -d --build --wait
bash scripts/dev.sh deploy-down       # docker compose down (keeps the volume)
```

- **Order:** `certs` copies certificates into volumes owned by user 65532 and exits; `postgres` becomes healthy; `migrate` runs `migrate up` with `.env.migrate` and must exit 0; then `api` starts with `.env.deploy`. If `migrate` fails, `api` never starts: read `docker compose -f compose.deploy.yaml logs migrate`.
- **Addresses:** the app at `https://localhost:8443`, captured mail at `http://localhost:8025` (both loopback only). PostgreSQL is not published; use `docker compose -f compose.deploy.yaml exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d ecom'`. It accepts only TLS from other containers.
- **Port 8443** is shared with `serve-https`; run one at a time. Production mode sends HSTS for `localhost`.
- **Run another binary** in the deployment: `docker compose -f compose.deploy.yaml run --rm api reconcile --dry-run` (uses `.env.deploy`) or `... run --rm migrate migrate status`.
- **Another image:** `ECOM_IMAGE=ecom:1.0.0 bash scripts/dev.sh deploy` (or a pulled `<name@digest>`) runs that image with `--no-build`, so it is never rebuilt or retagged; a missing image is refused.
- **Reset** the deployment's data deliberately with `docker compose -f compose.deploy.yaml down -v`; it removes only `ecom-deploy_*` volumes, never the development `ecom_postgres_data`.

### Deployment verification

```bash
bash scripts/dev.sh deploy-verify     # about 1 minute; KEEP=1 leaves the project running
TRACE=1 bash scripts/dev.sh deploy-verify   # also keep a Playwright trace of a failed journey
```

Builds the image and runs [`scripts/deploy-verify.sh`](../../../scripts/deploy-verify.sh) in its own project, `ecom-deploy-verify`, on new volumes that it removes at the end. It needs Docker, Go, Node 24.20.0 with the frontend dependencies and Playwright Chromium, the certificates, the three deployment env files, and ports 8443, 8025 and 55432 free (stop `deploy` or `serve-https` first). Each step prints `PASS:` or stops with `FAIL:`: empty-volume start and migration summary, HTTPS readiness, a headless Chromium journey with captured mail, `reconcile --dry-run` and `--apply` on a stranded order inside the deployment, a full restart, and telemetry off and on. Passwords are read from `.env.postgres` and never printed. On any failure, the API and migrate logs are saved to `.cache/deploy-verify/api.log` before the project is removed; with `TRACE=1`, the failed test's trace is kept in `.cache/deploy-verify/playwright/` (open it with `npx playwright show-trace`). Before the browser starts, the script waits (up to 10 s) until no Docker `veth`/`br-` interface has a tentative IPv6 address; see [DECISIONS.md](../DECISIONS.md#packaging-milestone-16).

### Telemetry in the deployment

`.env.deploy` leaves telemetry off. To export it, start the debug Collector and the override that configures the API:

```bash
docker compose -f compose.deploy.yaml -f compose.deploy.telemetry.yaml --profile telemetry up -d --wait
docker compose -f compose.deploy.yaml --profile telemetry logs collector
```

The Collector ([`collector.deploy.yaml`](../../../scripts/telemetry-check/collector.deploy.yaml)) receives OTLP/HTTP on `collector:4318`, scrapes `api:9464` every 5 s, and prints both; nothing is published to the host. To turn it off, run `bash scripts/dev.sh deploy` (recreates `api` without the override), then `docker compose -f compose.deploy.yaml --profile telemetry stop collector`.

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

`scripts/connect.sh` opens `psql` on the development database inside the PostgreSQL container as the `postgres` superuser; `scripts/fixture.sh psql` opens a fixture database as the runtime role `ecom_app`, which cannot run this UPDATE (fixtures already include an `admin` account). Check which role you are connected as before running the UPDATE. Keep credentials out of shell history and shared logs.

## Remove expired guest data

```bash
bash scripts/dev.sh maintain guests                    # until a batch changes nothing (at most 20 batches)
bash scripts/dev.sh maintain guests --max-batches 1    # one batch
```

`maintain guests` (M17 task 8) runs the embedded [`backend/maintenance/guest_sessions.sql`](../../../backend/maintenance/guest_sessions.sql) with the migrator's credentials (`DATABASE_URL`, `APP_ENV`); the SQL refuses any other role, so the runtime role can't run it. Each batch is one transaction with a 5-second deadline that changes at most 500 rows per table:

- **Guests** whose sessions all expired at least 7 days ago (idle or absolute deadline), with their sessions, carts, cart items and cart choices. Guests with an order or a checkout intent are kept.
- **Checkout intents** past their deadline: closed as `expired`, contact and shipping scrubbed.
- **Recovery proofs and grants** 7 days after they expired.

It repeats batches until one changes nothing, or until `--max-batches` (1–1000). Output is JSON Lines: one `batch` line per batch (`deleted`, `updated`), then a `summary` with `complete: true` when nothing was left. A failed batch rolls back; earlier batches stay committed, and rerunning continues. On AWS, task 10 schedules it after `reconcile`.

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
| Image missing | `docker pull postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab` (the digest in `compose.yaml`); the script never pulls |
| `WARN` `http: TLS handshake error ... unknown certificate` | The client does not trust `ca.pem` (expected for browsers and tools that were not given it). Not a server fault. |
| `WARN` `security email delivery unconfirmed` | The SMTP exchange failed or exceeded its 2 s budget; the request still returned 202 with delivery `unconfirmed`. Send again. If it repeats, test the server and credentials outside the API, as in the [controlled mailbox test](#email-smtp). |
| `localhost` dev pages suddenly redirect to HTTPS | The browser stored HSTS from a production-mode run; see [Production mode on one host](#production-mode-on-one-host) |

Stop the API with Ctrl+C (10 s graceful shutdown). Stop the database with `docker compose stop postgres`. Never reset the volume to fix a startup problem.

Production backup and restore are not covered.
