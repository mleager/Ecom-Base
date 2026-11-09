# Commerce Reliability Lab — Project 1

Backend Milestones 1–5 are complete; see the
[consolidated verification report](docs/backend/evidence/MILESTONE_5_BACKEND_VERIFICATION.md).
Frontend Milestones 6–12 are complete, including functional and
[visual acceptance](docs/frontend/VISUAL_ACCEPTANCE.md). Customer and administrator
pages share the selected dark visual system and pass post-polish regressions.
Milestone 13 Tasks 1–5 are complete. API 1.7.0 with readiness 13 implements the Task 5 guest checkout, order and recovery backend. Task 6 owns frontend guest lifecycle, and Milestone 14 owns packaging and release. [Project status](docs/PROJECT_STATUS.md) · [Shopping revision](docs/frontend/SHOPPING_EXPERIENCE.md)
See [current status](docs/PROJECT_STATUS.md) and
[acceptance outcomes/limits](docs/frontend/TEST_PLAN.md#milestone-11-functional-acceptance-and-visual-polish-handoff).
Go runs locally;
Docker Compose runs PostgreSQL only. No Go, goose, sqlc, test, or API tool image
is built or pulled.

`compose.yaml` and the ignored `.env` live in the repository root. Run ordinary
`docker compose` commands there. The PostgreSQL bootstrap script remains at
`infrastructure/postgres/init.sh` and is mounted into the container by Compose.

Implemented: five initial schema migrations, four permission migrations and credential-version
migrations 10–11 (credential versioning, verification and token/pending-email storage), generated pgx queries, validated configuration, a bounded connection
pool, structured request logs, graceful shutdown, root health checks, customer
registration, login, rotating refresh/logout sessions, authenticated account
reads/updates, saved-address CRUD, public catalog browsing, administrator product
and stock management, persistent carts, administrator authorization for metrics,
complete T1 checkout, processing claims, deterministic simulated payments,
atomic settlement/cancellation, customer order/payment APIs, and an explicit
recovery command with read-only diagnostics.

Current completion and remaining project work are in
[PROJECT_STATUS.md](docs/PROJECT_STATUS.md). Checkout and order HTTP routes are
enabled. Operator recovery is documented in [RECOVERY.md](docs/backend/RECOVERY.md).

Documentation starts at the [documentation map](docs/README.md). Detailed
[backend documentation](docs/backend/README.md) and
[frontend](docs/frontend/OVERVIEW.md) have separate directories. Project-wide
scope, milestone ordering and status remain in the top-level `docs/` summaries.
Final packaged verification and the tagged baseline release are still pending.
For the initialized Vite/React/TypeScript workspace and local commands, see the
[frontend README](frontend/README.md).

For the complete setup, configuration, migration-status, administrator provisioning,
health and troubleshooting procedure, use the [operator guide](docs/backend/OPERATIONS.md).

## Prerequisites

- Go 1.26 or newer (`go.mod` says `go 1.26.0`), goose 3.27.1, and sqlc 1.31.1 on PATH. Use PowerShell on
  Windows or Bash and OpenSSL on Linux/macOS. Race tests also need a C compiler.
- Docker's Linux engine and the already downloaded `postgres:16-alpine`
  image. The database command uses `--pull never`; download that image explicitly
  if it is missing. No tooling containers are used.
- Run commands from this repository root. `GOTOOLCHAIN=local` prevents implicit
  Go upgrades. Dependencies are pinned in `go.mod`/`go.sum`.

Goose is used as the installed executable, not imported or compiled by this
module. sqlc is also an installed executable.

## First start

```powershell
./scripts/dev.ps1 init-env
./scripts/dev.ps1 database
./scripts/dev.ps1 status
./scripts/dev.ps1 migrate
./scripts/dev.ps1 status
./scripts/dev.ps1 run
```

On Linux or macOS, use the equivalent Bash commands:

```bash
bash scripts/dev.sh init-env
bash scripts/dev.sh database
bash scripts/dev.sh status
bash scripts/dev.sh migrate
bash scripts/dev.sh status
bash scripts/dev.sh run
```

`init-env` creates a git-ignored `.env` with separate random database passwords
and a random base64 JWT secret. It refuses to overwrite an existing file. The
scripts read plain `KEY=value` entries without shell evaluation or expansion.
Change `POSTGRES_PORT` before starting if 5432 is already in use. The API defaults
to `127.0.0.1:8080` and the database binds only to loopback.

The database initialization script creates a migration owner and a restricted
runtime login. Initialization runs only on the volume's first boot: editing
passwords in `.env` does not rotate existing PostgreSQL passwords. Keep that file
private, use explicit operator SQL for rotation, and never reset volumes as a
password-change shortcut.

Migration 6 adds only the column writes authentication needs: create a customer
and cart, insert/rotate/revoke sessions, and upgrade password hashes. Runtime SQL
cannot set user roles/activation flags, create tables, or edit migration status.
Migration 7 adds profile/address/catalog/on-hand inventory/cart write permissions.
Migration 8 adds T1 record insertion and reservation-counter writes. Migration 9
adds only the state/timestamp/failure-code writes for settlement and cancellation.
Runtime SQL cannot reassign ownership, change user roles/activation, physically
delete products, rewrite order/item snapshots, or change payment scenarios and
attempt identities. The API enforces resource ownership and administrator policy.
The API never runs migrations. When code/schema changes require it, apply the
approved migrations, confirm status/version 11 and restart an older local API.
The status action uses local goose and migration credentials; it does not apply
domain migrations, but goose may initialize its metadata on a new database.

Health checks from another terminal:

```powershell
Invoke-WebRequest http://127.0.0.1:8080/health/live
Invoke-WebRequest http://127.0.0.1:8080/health/ready
```

Readiness returns 503 until PostgreSQL is reachable with the runtime credentials
and goose version 11 is applied. The process stays live during database outages;
readiness can recover after migrations or connectivity are restored. Stop the API
with Ctrl+C for graceful shutdown.

## Local HTTPS run mode

Serves the built frontend and the API together on one HTTPS origin,
`https://localhost:8443`, the way the app is deployed. Bash only.

```bash
bash scripts/certs.sh                          # once: local CA and certificates in .cache/certs/
cd frontend && npm ci --strict-peer-deps && cd ..   # once: frontend dependencies
bash scripts/dev.sh fixtures-https             # optional: seeded demo data; prints a fixture ID
bash scripts/dev.sh serve-https <fixture-id>   # omit the ID to use the development database
```

`serve-https` builds the frontend, then starts the API in local mode with TLS.
Open exactly `https://localhost:8443` (not `127.0.0.1`), and stop it with
Ctrl+C. Trust `.cache/certs/ca.pem` in your browser to avoid the certificate
warning. Local mode never sends HSTS, so the Vite dev server on
`http://localhost:5173` keeps working afterwards. Details:
[Local HTTPS run mode](docs/updated/DEVELOPMENT.md#local-https-run-mode).

## Run the application image (deployment profile)

Runs the release the way it is deployed: the application image in production
mode, its own PostgreSQL volume with TLS required, a migration job, and a local
mail-capture server so no mail leaves the machine. Bash and Docker only; it
uses port 8443, so stop `serve-https` first.

```bash
bash scripts/certs.sh                 # once: also adds the mail certificate to an older set
bash scripts/dev.sh init-deploy-env   # once: .env.postgres, .env.migrate, .env.deploy (new secrets)
bash scripts/dev.sh deploy            # build the image, start everything, wait for a ready API
bash scripts/dev.sh deploy-down       # stop; the deployment's database volume is kept
```

Open `https://localhost:8443` (trust `.cache/certs/ca.pem`) and read captured
mail at `http://localhost:8025`. Production mode sends HSTS for `localhost`, so
use a separate browser profile, or clear the HSTS entry afterwards, if you go
back to the plain-HTTP Vite server. Details:
[Deployment profile](docs/updated/backend/OPERATIONS.md#deployment-profile).

## Check the metrics locally

Telemetry is off by default. Setting `METRICS_ADDR` starts a second, internal
listener that serves Prometheus metrics. No Prometheus or Grafana is needed to
look at them. 9464 is the conventional OpenTelemetry Prometheus port; any free
loopback port other than the API's works.

```bash
METRICS_ADDR=127.0.0.1:9464 bash scripts/dev.sh serve-https <fixture-id>
```

Use the app in the browser, then from another terminal:

```bash
curl -s http://127.0.0.1:9464/metrics | grep http_server
```

- The metrics listener is plain HTTP, even when the API serves HTTPS.
- `http_server_request_duration_seconds` is labelled by method, route pattern and
  status class. Pages and assets served by the API appear as `http_route="static"`;
  unknown paths as `unmatched`. `http_server_active_requests` counts requests in
  progress. Go runtime (`go_*`) and process (`process_*`) metrics are included.
- Database: `db_client_operation_duration_seconds` by query name (for example
  `db_operation_name="GetProduct"`), and pool metrics such as
  `db_client_connection_count` (`used`, `idle`), `db_client_connection_max` and
  `db_client_connection_wait_time_seconds`. Try
  `curl -s http://127.0.0.1:9464/metrics | grep db_client`.
- Business: `ecom_orders_created_total`, `ecom_payment_results_total`,
  `ecom_checkout_unknown_outcomes_total`, `ecom_guest_sessions_created_total`,
  `ecom_rate_limit_rejections_total` (by limiter) and `ecom_email_deliveries_total`.
  They start at 0; place an order in the browser and `grep ecom_` to see them move.
- Values live in the API's memory and reset when it restarts.
- `METRICS_ADDR` works the same with `bash scripts/dev.sh run` or `fixture-run`.
  Pass it on the command line rather than in `.env`: `.env` applies to every
  `dev.sh` command, including the test suites.
- `GET /metrics` on the API port is a different, admin-only route.

Traces are off unless `OTEL_EXPORTER_OTLP_ENDPOINT` points at an OTLP/HTTP
collector. See [Telemetry](docs/updated/backend/OPERATIONS.md#telemetry-optional).
To see the spans as well, run the debug Collector described in
[Telemetry export check](docs/updated/backend/OPERATIONS.md#telemetry-export-check).
Every metric, span and log field is listed in the
[observability contract](docs/updated/backend/OBSERVABILITY_CONTRACT.md).

## Authentication API

| Method and path | Behavior |
|---|---|
| `POST /api/v1/auth/register` | Create a customer and its persistent cart atomically; return the user |
| `POST /api/v1/auth/login` | Verify credentials; return a 15-minute access JWT and set a refresh cookie |
| `POST /api/v1/auth/refresh` | Rotate the current refresh verifier; retain the original seven-day expiry |
| `POST /api/v1/auth/logout` | Revoke the cookie's session and clear it; no access JWT required |
| `GET /api/v1/users/me` | Return the current active user after bearer and database-session validation |
| `POST /api/v1/users/me/password` | Verify current password, replace it atomically and revoke all sessions; explicit login required |
| `GET /metrics` | Require the current database role to be admin; expose an authentication request counter |

Passwords are preserved exactly and must contain 15–128 Unicode code points
(at most 512 UTF-8 bytes). Stored passwords use Argon2id at 64 MiB/3 iterations.
Registration never accepts a role. The same trimmed/lowercase email cannot be
registered twice. Registration does not automatically create a login session.

Login, refresh, logout and password changes require both `Origin: http://localhost:5173` and
`X-CSRF-Protection: 1` in the default local configuration. Set `FRONTEND_ORIGIN`
explicitly for a different frontend; production requires an HTTPS origin.
Registration/login JSON schemas are in `docs/api/openapi.yaml`. For authenticated
requests send `Authorization: Bearer <access_token>`. Keep access tokens in memory;
browser requests to refresh/logout must include credentials so the HttpOnly cookie
is sent. Local HTTP cookies omit Secure; production mode enables it.

Use `/account/security` in the frontend to change a password. Its credentialed
bearer request supplies `current_password` and `new_password`; current-password
failure is 403. Success signs out every session and clears the refresh cookie.
The browser sends this write once and hides private state after an uncertain
result; deliberate sign-in checks the outcome. Migration 10 adds only an internal
credential version. Migration 11 adds explicit email verification and security proofs.
Use Account security to request a verification email, then confirm the emailed link
with the requesting account/current password. Existing emails start unverified;
verification preserves sessions. Verified password changes send a best-effort notice
(`accepted`/`unconfirmed`); unverified addresses return `not_applicable`.
See [SMTP setup and token pruning](docs/backend/OPERATIONS.md#security-email-configuration-and-verification).
Account security also supports verified email changes: confirm both mailbox links
with the current password, then sign in with the new email. The first proof keeps
the old email; completion revokes every session and preserves account ownership.
Replacement/cancellation, duplicate conflicts and uncertain outcomes have explicit
status/recovery handling. Emailed password recovery remains M9 task 6.

Clients must serialize refresh calls: one concurrent use of the current cookie
wins, and stale tokens return 401 without clearing a newer cookie. Expiry is based
on PostgreSQL time and is never extended. Logout revokes that session immediately
for subsequent authorization checks, including its still-unexpired access JWTs.
Other sessions remain valid. Old refresh-token families are not tracked by the
approved schema. If a rotation commits but its response is lost, the old cookie
cannot recover the new secret; sign in again. Errors never claim automatic session
recovery. Login/register rate limits and the two-operation hashing limit may
return 429 with Retry-After.

No administrator is seeded. An authorized operator can promote an explicitly
selected registered user using a parameterized maintenance query, with that
user's UUID bound as `$1`:

```sql
UPDATE users SET role = 'admin', updated_at = now()
WHERE id = $1 AND role = 'customer' AND is_active
RETURNING id, email, role;
```

Use migration/operator credentials for that intentional action; the runtime role
cannot execute it. Customer endpoints cannot promote users or deactivate accounts.
The [administrator procedure](docs/backend/OPERATIONS.md#provision-an-administrator)
defines identity inspection, parameter binding, transaction review and verification.

## Account, catalog and cart APIs

For isolated demonstration/test data, use `./scripts/dev.ps1 fixtures` or
`bash scripts/dev.sh fixtures`. The [fixture guide](docs/frontend/FIXTURES.md)
covers generated credentials, versioned images, API startup and owned cleanup;
ordinary development data is preserved.

All paths below start with `/api/v1`. Only public product browsing is anonymous;
other operations require a bearer access token. Administrator operations also
check the user's current database role.

| Method and path | Behavior |
|---|---|
| `PATCH /users/me` | Update supplied first/last names; preserve omitted fields |
| `GET /users/me/addresses` | List the caller's saved addresses |
| `POST /users/me/addresses` | Create a validated US shipping address |
| `PATCH /users/me/addresses/{id}` | Update an owned address |
| `DELETE /users/me/addresses/{id}` | Delete an owned saved address |
| `GET /products` | Browse or literal name/SKU search with optional `q`, `limit`/`offset`, ordered by name and ID |
| `GET /products/{id}` | Read an active product and current availability |
| `GET /admin/products` | List active/retired products with optional `is_active`, `limit`/`offset` |
| `GET /admin/products/{id}` | Read an active or retired product as current administrator |
| `GET /admin/products/{id}/inventory` | Read coherent on-hand/reserved/available counters without a stock write |
| `POST /admin/products` | Atomically create a product and its zero-stock inventory row |
| `PATCH /admin/products/{id}` | Update supplied product fields or reactivate a product |
| `DELETE /admin/products/{id}` | Retire a product without deleting its data |
| `PATCH /admin/products/{id}/inventory` | Apply a signed on-hand adjustment, preserving reservations |
| `GET /cart` | Read a coherent cart/version snapshot |
| `POST /cart/items` | Add quantity to a product's existing line or create a line |
| `PATCH /cart/items/{id}` | Replace the quantity of an owned item |
| `DELETE /cart/items/{id}` | Remove an owned item |
| `DELETE /cart/items` | Clear the cart, including an already empty cart |

Request/response schemas and status codes are in [OpenAPI](docs/api/openapi.yaml).
PATCH rejects null, unknown fields and empty objects. Optional text can be
cleared with an empty string; omitted fields retain their values. Duplicate SKUs
return 409. Cart quantities are 1–10,000 with at most 100 distinct products. All
successful cart changes increment the locked cart version once, even unchanged
quantity/empty-clear operations. Missing/foreign items return 404 without a change.
Adding/replacing quantities requires an active product; removing retired items
remains possible. Carts do not require available stock or reserve it; checkout
will perform the definitive stock and price checks.

## Checkout and order APIs

`checkout.Service.CreatePending(ctx, authenticatedUserID, key, request)` creates
the complete pending-order graph, inventory holds and cart consumption in one
transaction. The request contains `cart_version`, `shipping_address_id` and
`payment_scenario`; the caller supplies the authenticated actor separately.
The HTTP service then commits a processing claim, runs the local simulator
outside any transaction, and atomically settles every reservation in T2.

| Method and path (under `/api/v1`) | Behavior |
|---|---|
| `POST /checkout` | Require bearer authentication and one `Idempotency-Key`; create and process a checkout |
| `GET /orders` | List owned orders, newest first, with bounded `limit`/`offset` |
| `GET /orders/{id}` | Read an owned order with immutable snapshots and current payment status |
| `GET /orders/{id}/payments` | Read safe payment attempt fields for an owned order |
| `POST /orders/{id}/cancel` | No body; cancel only before processing is claimed, or return the already cancelled order |

`payment_scenario` is explicitly a Project 1 simulator input: `accept` confirms
the order and consumes stock; `reject` creates a `payment_failed` order and
releases holds. No real payment occurs. A newly settled order returns 201 for
either scenario. Identical retries return 200. A known committed pending order
after interruption returns 202. An unresolved COMMIT returns 503; retry the
identical key/body (or cancellation for the same order). Never create a new key
to resolve an uncertain checkout.

Identical user/key/intent retries return the retained order/current status even
after cart clearing or source edits/deletion. Changed intent conflicts. Stock is
reserved in UUID order, totals are computed from server prices with bounds, and
all inserts/cart changes roll back on failure. Lost COMMIT acknowledgement uses
a bounded lookup on an independent healthy connection and the same advisory
lock. An unresolved outcome returns the service's `checkout_outcome_uncertain`
error; callers must retry the identical key/body. The service never blindly
replays an uncertain transaction or processes payment on an existing-key retry.

GET and same-key retries only observe status. They never resume an interrupted
pending/processing attempt. Holds remain active until explicit settlement or
eligible cancellation; the 15-minute threshold does not release stock. The
operator recovery command now resumes eligible interrupted orders explicitly.
There is no automatic recovery runner.

See [T1 evidence](docs/backend/evidence/MILESTONE_2_CHECKOUT.md) and
[payment evidence](docs/backend/evidence/MILESTONE_3_PAYMENTS.md) for PostgreSQL contention,
rollback, HTTP, cancellation-race and connection-loss verification.

## Recover interrupted orders

__Using Powershell__:
```powershell
./scripts/dev.ps1 reconcile -Limit 100
./scripts/dev.ps1 reconcile -Apply -Limit 100
```

__Using Bash__:
```bash
bash scripts/dev.sh reconcile --dry-run --limit 100
bash scripts/dev.sh reconcile --apply --limit 100
```

The first command is read-only; the second explicitly applies recovery. 
Both use local Go and runtime database credentials. 
No JWT secret is needed by the command itself.

Recovery considers pending orders at least 15 minutes old, claims pending
attempts or re-derives processing outcomes, and reuses exactly-once settlement.
Concurrent operators skip locked candidates; corrupt state is reported without
automatic repair. JSON Lines include action events and a bounded diagnostic
summary; inconsistent, failed or unresolved runs exit nonzero. See
[operator instructions](docs/backend/RECOVERY.md) for limits, cutoff behavior and safe reruns.

## Generate and verify locally

```powershell
./scripts/dev.ps1 generate
./scripts/dev.ps1 check
./scripts/dev.ps1 integration
```

The Bash equivalents are `bash scripts/dev.sh generate`,
`bash scripts/dev.sh check`, and `bash scripts/dev.sh integration`.

`check` verifies formatting, sqlc SQL, unchanged generated code, goose migration
syntax, `go vet`, and `go test ./...`. `integration` runs native Go tests with the
integration build tag against a randomly named database created on the local
PostgreSQL server. It requires the initialized project database roles and an
administrative connection, creates only `ecom_foundation_<random>` databases, and
removes its own database through test cleanup. It never applies down migrations
to the development database. These commands fail on missing configuration or
unavailable PostgreSQL; integration tests do not silently skip.

For race detection on a host with a working C compiler:

```powershell
./scripts/dev.ps1 test -Race
./scripts/dev.ps1 integration -Race
```

In Bash, use `bash scripts/dev.sh test --race` and
`bash scripts/dev.sh integration --race`.

Direct `go run ./backend/cmd/api` requires explicit process variables `APP_ENV`,
`DATABASE_URL`, and `JWT_SECRET_BASE64`; local mode defaults `FRONTEND_ORIGIN` to
`http://localhost:5173`, while production requires it explicitly. `.env` loading
belongs to the development script, not the application. Database connections require
`sslmode=verify-full`; only explicit local loopback connections may disable TLS.

## Manage PostgreSQL from the repository root

Compose discovers both root `compose.yaml` and `.env` automatically:

```powershell
docker compose config --quiet
docker compose stop postgres
docker compose down
```

`config --quiet` validates configuration without printing credentials or changing
containers. `stop` stops PostgreSQL; `down` removes the project's containers and
network while retaining the named database volume. Start PostgreSQL through
`./scripts/dev.ps1 database` (or `bash scripts/dev.sh database`); both scripts
switch to the root and explicitly select the root Compose/env files.

From `infrastructure/`, use explicit paths to the root files:

```powershell
docker compose --env-file .env -f ../compose.yaml down
```

The Compose project name remains `ecom` and its named database volume remains
`ecom_postgres_data`. Moving the Compose file preserves that volume and the same
bootstrap-script source. The script runs automatically only when PostgreSQL
initializes an empty data directory; restarting an existing database does not
rerun it. Apply application schema changes with the separate goose migrations.

