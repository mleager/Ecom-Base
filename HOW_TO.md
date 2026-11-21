# How to run the project

Every command for setting up, running, testing and deploying Project 1, in the
order you need them. Run everything from the repository root in Bash (Linux)
unless a step says `cd frontend`. Windows PowerShell equivalents for the basic
development flow are in [Windows (PowerShell)](#10-windows-powershell).

1. [Prerequisites](#1-prerequisites)
2. [First-time setup (HTTP)](#2-first-time-setup-http)
3. [HTTPS setup](#3-https-setup)
4. [Demo data (fixtures)](#4-demo-data-fixtures)
5. [Everyday development](#5-everyday-development)
6. [Testing](#6-testing)
7. [The release image](#7-the-release-image)
8. [Operations: metrics, order recovery, administrators](#8-operations-metrics-order-recovery-administrators)
9. [Deploy to AWS (development stack)](#9-deploy-to-aws-development-stack)
10. [Windows (PowerShell)](#10-windows-powershell)
11. [Configuration and troubleshooting](#11-configuration-and-troubleshooting)
12. [More detail](#12-more-detail)

Three scripts cover the commands below; run them as `bash scripts/<name>.sh` or
`./scripts/<name>.sh`:

| Script | Use |
|---|---|
| `scripts/dev.sh` | Setup, running the app, tests, the release deployment |
| `scripts/fixture.sh` | Demo-data databases: create, list, run, serve, psql, remove |
| `scripts/connect.sh` | `psql` on the development database |

They read `.env` literally (no shell expansion), build the database URLs
themselves and run Go with `GOTOOLCHAIN=local`. Running a script with no
arguments prints its usage.

## 1. Prerequisites

| Need | Check |
|---|---|
| Go 1.26 or newer (1.27.3 verified) | `go version` |
| goose 3.27+ (3.28.0 verified), sqlc 1.31.1, govulncheck 1.9.0 on `PATH` | `goose -version`, `sqlc version`, `govulncheck -version` |
| Docker Engine with Compose v2 and Buildx | `docker compose version`, `docker buildx version` |
| Node 24.20.0 and npm 11.19.0, exactly | `node -v`, `npm -v` (`nvm use 24.20.0`) |
| OpenSSL and curl; a C compiler for `--race` | `openssl version`, `gcc --version` |

Install govulncheck if it is missing:

```bash
go install golang.org/x/vuln/cmd/govulncheck@v1.9.0
```

The development database never pulls its image (`--pull never`), so pull it once:

```bash
docker pull postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab
```

Only the [release image](#7-the-release-image) path can run without Go, Node or
PostgreSQL on the host; it needs Docker, Bash, Git, OpenSSL and curl.

## 2. First-time setup (HTTP)

The everyday development stack: PostgreSQL in Docker, the Go API on
`http://127.0.0.1:8080`, and the Vite dev server on `http://localhost:5173`.

**0. Get the code.** Release 1.0.0 is the tag `base-v1.0.0`.

```bash
git clone https://github.com/mleager/Ecom-Base.git && cd Ecom-Base
```

**1. Create `.env`** with random database passwords and a JWT secret. It refuses
to overwrite an existing file.

```bash
bash scripts/dev.sh init-env
```

Change `POSTGRES_PORT` in `.env` before the next step if 5432 is in use. The
passwords are applied only when the database volume is first created; editing
`.env` later does not change them.

**2. Start PostgreSQL and apply the migrations.**

```bash
bash scripts/dev.sh database      # start PostgreSQL and wait until it is healthy
bash scripts/dev.sh migrate       # apply migrations 1–13
bash scripts/dev.sh status        # confirm version 13
```

**3. Start the API** (terminal 1; Ctrl+C stops it gracefully).

```bash
bash scripts/dev.sh run
```

**4. Check health** (terminal 2). Both return 200 once migrations are applied;
`ready` returns 503 while the database is unreachable or older than version 13.

```bash
curl -i http://127.0.0.1:8080/health/live
curl -i http://127.0.0.1:8080/health/ready
```

**5. Install and start the frontend** (terminal 2).

```bash
cd frontend
npm ci --strict-peer-deps
npm run dev
```

Open `http://localhost:5173`. Use `localhost`, not `127.0.0.1`: the refresh
cookie and the API's origin check need matching host names.

No account is seeded. Register in the app, or use [fixtures](#4-demo-data-fixtures)
for ready-made accounts.

## 3. HTTPS setup

Runs the app the way it is deployed: one HTTPS origin, `https://localhost:8443`,
where the Go API serves both the built frontend and `/api/v1`. Needs the
[HTTP setup](#2-first-time-setup-http) first (database, migrations, `npm ci`).

**1. Create local certificates** (once). They go in the git-ignored
`.cache/certs/`; `ca.pem` is the only file a browser should trust, and `ca.key`
must stay private. The script never overwrites a complete set.

```bash
bash scripts/certs.sh
```

**2. Trust the CA in your browser** (optional; avoids the certificate warning).
In Chrome, import `.cache/certs/ca.pem` under Settings → Privacy and security →
Security → Manage certificates → Authorities. From the command line (needs
`libnss3-tools`):

```bash
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Commerce Lab Local CA" -i .cache/certs/ca.pem
```

**3. Serve over HTTPS.** This builds the same-origin frontend into
`frontend/dist`, then starts the API in local mode with TLS on port 8443
(Ctrl+C to stop). It uses the development database; `run` on port 8080 can keep
running alongside it.

```bash
bash scripts/dev.sh serve-https
curl --cacert .cache/certs/ca.pem https://localhost:8443/health/ready
```

Open exactly `https://localhost:8443`. On any other address (such as
`https://127.0.0.1:8443`) pages load, but sign-in, the cart and checkout stay
disabled. Local mode never sends HSTS, so the Vite server on port 5173 keeps
working afterwards.

**Optional: PostgreSQL with TLS.** Recreates the development container with TLS
offered (the data volume is kept), checks `verify-full` connections, and switches
back.

```bash
bash scripts/dev.sh database-tls        # PostgreSQL with TLS
bash scripts/dev.sh database-tls-check  # verify-full passes; wrong host or untrusted CA fails
bash scripts/dev.sh database            # back to the default container without TLS
```

## 4. Demo data (fixtures)

A fixture is a separate, disposable database with 36 products and three accounts
(`customer_one`, `customer_two`, `admin`). Your development data is not touched.
Needs PostgreSQL running and `.env` present.

Each `create` prints a new ID of the form `ecom_fixture_<16 hex>`. Wherever a
command takes `[id]`, you can give the full ID or a unique prefix (`5d5e`), or
leave it out: with one fixture it is used automatically, and with several you
pick from a numbered list.

**Over HTTP** (API on 8080, frontend on the Vite server):

```bash
bash scripts/fixture.sh create            # create; prints the ID
bash scripts/fixture.sh run [id]          # terminal 1: the API against that fixture (stop `dev.sh run` first)
cd frontend && npm run dev                # terminal 2: http://localhost:5173
```

**Over HTTPS** (needs [certificates](#3-https-setup)). A fixture made without
`--https` points its product images at the Vite origin, so create one for the
HTTPS origin:

```bash
bash scripts/fixture.sh create --https    # create for https://localhost:8443; prints the ID
bash scripts/fixture.sh serve [id]        # https://localhost:8443 against that fixture
```

**Sign in:** the accounts' emails and passwords are random for every fixture and
are stored only in `.cache/fixtures/<id>/bundle.json` (mode 0600). Read them
locally; never copy them into docs, logs or commits.

**Inspect, query or remove fixtures:**

```bash
bash scripts/fixture.sh list                      # IDs and origins; marks incomplete folders
bash scripts/fixture.sh check [id]                # verify ownership, schema and private files
bash scripts/fixture.sh psql [id]                 # psql on the fixture database, as the runtime role ecom_app
bash scripts/fixture.sh psql [id] -c 'select count(*) from products'
bash scripts/fixture.sh remove [id]               # drop its database and delete its private files (asks first)
```

## 5. Everyday development

**Start again after a reboot:**

```bash
bash scripts/dev.sh database
bash scripts/dev.sh run
cd frontend && npm run dev
```

**When new migration files arrive:** `bash scripts/dev.sh migrate`, then
`bash scripts/dev.sh status`, then restart the API. The API never migrates itself.

**After changing SQL queries:** regenerate the sqlc code and commit the files in
`backend/internal/db/sqlc/`.

```bash
bash scripts/dev.sh generate
```

**Before committing:**

```bash
bash scripts/dev.sh check                         # backend work
cd frontend && npm run typecheck && npm test      # frontend work, plus the affected browser group
```

**Query the development database** with `psql` as the `postgres` superuser
(any arguments go to `psql`):

```bash
bash scripts/connect.sh
bash scripts/connect.sh -c 'select email, role from users'
```

**Manage the development PostgreSQL** (Compose reads the root `compose.yaml` and
`.env`; the project is `ecom`, the volume `ecom_postgres_data`):

```bash
docker compose config --quiet     # validate without printing secrets
docker compose stop postgres      # stop; keep the data
docker compose down               # remove container and network; keep the volume
```

Never add `-v` to `down` (it deletes the data), and never reset the volume to
change a password. Start PostgreSQL again with `bash scripts/dev.sh database`.

**Running the API without the script:** `go run ./backend/cmd/api` needs
`APP_ENV`, `DATABASE_URL` and `JWT_SECRET_BASE64` in the process environment; it
does not read `.env`. Only local loopback database connections may skip TLS;
anything else needs `sslmode=verify-full`.

## 6. Testing

Run the suites one at a time, never two heavy ones together (for example
`integration` and the browser suite). On the development machine, whose CPU
cores 8–9 are unreliable, pin heavy runs to the other cores by prefixing them
with `taskset -c 0-7,10-31`.

**Backend.** Both need PostgreSQL running and `.env`. `integration` creates and
removes its own `ecom_foundation_<random>` databases; it never touches
development data.

```bash
bash scripts/dev.sh check                 # gofmt, sqlc vet, generated code, goose validate, go vet, govulncheck (network), go test
bash scripts/dev.sh test --race           # unit tests with the race detector
bash scripts/dev.sh integration --race    # all PostgreSQL integration tests (about 5 minutes)
```

**Frontend unit tests and build:**

```bash
cd frontend
npm run typecheck
npm test                  # Vitest; npm run test:watch while editing
npm run build
```

**Browser tests (Playwright).** Install Chromium once:

```bash
cd frontend
npm exec -- playwright install chromium --only-shell
```

They start their own Go API and Vite server per worker against throwaway
databases. They need PostgreSQL running, `.env`, Go and goose, and ports
5173–5176 and 18080–18083 free with the default four workers (`E2E_WORKERS` sets
1–16).

```bash
cd frontend
npm run test:e2e              # all 348 tests (about 5 minutes)
npm run test:e2e:auth         # or one group: auth, storefront, checkout, admin, harness
npm run test:e2e:smoke        # public shell only; no database needed
npm run test:e2e:failed       # re-run the last failures
npm run test:e2e:https        # 10 tests over TLS on https://localhost:18443; needs scripts/certs.sh
```

Append `-- --grep "title"` to run matching tests only.

**Before a release,** run everything in this order: `check`,
`integration --race`, `npm run typecheck`, `npm test`, `npm run build`,
`npm run test:e2e`, `npm run test:e2e:https`, then
[`deploy-verify`](#verify-the-deployment-end-to-end).

## 7. The release image

One image, `ecom`, holds the API, the migration job (`migrate`), the
order-recovery CLI (`reconcile`), the guest cleanup (`maintain`), the AWS
database bootstrap (`db-bootstrap`) and the built frontend. The deployment profile
(`compose.deploy.yaml`, Compose project `ecom-deploy`) runs it in production
mode with TLS everywhere, its own database volume, a one-off migration job, and
Mailpit capturing all mail so nothing leaves the machine.

### First-time setup

```bash
bash scripts/certs.sh                 # local CA, server, postgres and mail certificates (once)
bash scripts/dev.sh init-deploy-env   # .env.postgres, .env.migrate, .env.deploy (mode 0600, new secrets; once)
```

The deployment's secrets are independent of `.env` and never overwritten.

### Build from the current source and run it

```bash
bash scripts/dev.sh deploy            # build the image, start everything, wait for a ready API
curl --cacert .cache/certs/ca.pem https://localhost:8443/health/ready
```

- App: `https://localhost:8443`. Captured mail: `http://localhost:8025`.
- Port 8443 is shared with `serve-https`; stop that first.
- Production mode sends HSTS for `localhost`. Open the app in a separate browser
  profile, or a desktop browser may then force HTTPS on every `localhost` port,
  including the Vite server.
- If the migration job fails, the API never starts; read its log with
  `docker compose -f compose.deploy.yaml logs migrate`.

### Run a recorded release (1.0.0)

Release 1.0.0 is the annotated Git tag `base-v1.0.0`; `git show base-v1.0.0`
records its commit and image ID. `ECOM_IMAGE` runs an existing image without
building or retagging it, either the published one by digest or a local build:

```bash
docker pull ghcr.io/mleager/ecom-base@sha256:00fc40884c550acadb2c577ad57af0d06d74329a13946704fd8ef87ac46e3d57
ECOM_IMAGE=ghcr.io/mleager/ecom-base@sha256:00fc40884c550acadb2c577ad57af0d06d74329a13946704fd8ef87ac46e3d57 bash scripts/dev.sh deploy
```

To build it locally from the tag instead, check out the tag and run the
release script. It builds from the committed tree only, checks the image, and
writes the evidence file; it refuses to replace an existing
`ecom-base:1.0.0`. Builds are not bit-for-bit reproducible, so the new image
ID will differ from the one in the tag.

```bash
git checkout base-v1.0.0
bash scripts/release-evidence.sh 1.0.0 release-evidence.md
git switch -                          # back to your branch
ECOM_IMAGE=ecom-base:1.0.0 bash scripts/dev.sh deploy
```

Fault-variant images for the scenario projects are built the same way from
their own documented branches, with `VARIANT` and `DESCRIPTION` set, and
published as `ghcr.io/mleager/ecom-<variant>`.

Schema 16. The migrations only add, so the older `m16-baseline` build still
starts against that database (readiness accepts newer schemas), but it
ignores the guest expiry and refresh reuse rules. An existing local volume
needs the `ecom_app` role defaults once
([DATABASE.md](docs/backend/DATABASE.md)).

### Work with the running deployment

```bash
docker compose -f compose.deploy.yaml ps
docker compose -f compose.deploy.yaml logs api
docker compose -f compose.deploy.yaml run --rm migrate migrate status
docker compose -f compose.deploy.yaml run --rm api reconcile --dry-run
docker compose -f compose.deploy.yaml exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d ecom'
```

**Telemetry** is off in the deployment. To export traces and metrics to a debug
Collector that prints them:

```bash
docker compose -f compose.deploy.yaml -f compose.deploy.telemetry.yaml --profile telemetry up -d --wait
docker compose -f compose.deploy.yaml --profile telemetry logs collector
```

Turn it off again with `bash scripts/dev.sh deploy`, then
`docker compose -f compose.deploy.yaml --profile telemetry stop collector`.

### Stop or reset

```bash
bash scripts/dev.sh deploy-down                  # stop; the deployment's database volume is kept
docker compose -f compose.deploy.yaml down -v    # stop and delete the deployment's data (ecom-deploy_* volumes only)
```

### Verify the deployment end to end

Builds the image and checks it in its own Compose project on new volumes, removed
afterwards: migration on empty volumes, HTTPS readiness, a headless browser
journey with captured mail, order recovery, a restart, and telemetry off and on.
Each step prints `PASS:` or stops with `FAIL:` (about 1 minute).

Needs Go, Node 24.20.0 with `npm ci` done and Playwright Chromium installed, the
certificates and deployment env files, and ports 8443, 8025 and 55432 free (stop
`deploy` and `serve-https` first).

```bash
bash scripts/dev.sh deploy-verify
KEEP=1 bash scripts/dev.sh deploy-verify     # leave the verification project running (it prints the down -v command)
TRACE=1 bash scripts/dev.sh deploy-verify    # on failure, also keep a Playwright trace
```

On failure, the API and migration logs are saved to `.cache/deploy-verify/api.log`;
with `TRACE=1`, the trace is in `.cache/deploy-verify/playwright/` (open it with
`npx playwright show-trace <file>` from `frontend/`).

## 8. Operations: metrics, order recovery, administrators

### Look at the metrics locally

Telemetry is off by default. `METRICS_ADDR` starts a second, plain-HTTP listener
with Prometheus metrics; it works with `dev.sh run`, `dev.sh serve-https`,
`fixture.sh run` and `fixture.sh serve`.
Pass it on the command line, not in `.env` (which every `dev.sh` command,
including the tests, reads).

```bash
METRICS_ADDR=127.0.0.1:9464 bash scripts/fixture.sh serve [id]
```

Use the app, then from another terminal:

```bash
curl -s http://127.0.0.1:9464/metrics | grep http_server   # requests by method, route and status class
curl -s http://127.0.0.1:9464/metrics | grep db_client     # query durations and connection pool
curl -s http://127.0.0.1:9464/metrics | grep ecom_         # orders, payments, guest sessions, rate limits, email
```

The values live in the API's memory and reset when it restarts. `GET /metrics`
on the API's own port is a different, admin-only route. Every metric, span and
log field is listed in the
[observability contract](docs/backend/OBSERVABILITY.md); traces
need an OTLP collector, see
[Telemetry](docs/backend/OPERATIONS.md#telemetry).

### Recover interrupted orders

Finds orders still waiting for payment at least 15 minutes after checkout and
finishes them. The dry run is read-only (and the default); `--apply` performs the
recovery. `--limit` is 1–1000 (default 100). Output is JSON Lines.

```bash
bash scripts/dev.sh reconcile --dry-run --limit 100
bash scripts/dev.sh reconcile --apply --limit 100
```

In the release deployment, use
`docker compose -f compose.deploy.yaml run --rm api reconcile --dry-run` instead.
Rules and output: [Recover interrupted orders](docs/backend/OPERATIONS.md#recover-interrupted-orders).

### Remove expired guest data

Removes guests whose sessions expired at least 7 days ago (with their carts),
closes overdue checkout intents and removes old recovery proofs. It runs as the
migrator, in batches of at most 500 rows, until a batch changes nothing.

```bash
bash scripts/dev.sh maintain guests
bash scripts/dev.sh maintain guests --max-batches 1
```

On AWS, a schedule runs it after `reconcile --apply` every 5 minutes.
Rules and output: [Remove expired guest data](docs/backend/OPERATIONS.md#remove-expired-guest-data).

### Make a user an administrator

No administrator is seeded. Promote a registered customer with a parameterized
SQL statement run as `ecom_migrator`; see
[Provision an administrator](docs/backend/OPERATIONS.md#provision-an-administrator).
`scripts/connect.sh` connects as the `postgres` superuser, which can run it too.
Fixtures already include an `admin` account.

## 9. Deploy to AWS (development stack)

Milestone 17 runs the same image on AWS: the SPA on S3 behind CloudFront, two or
more API tasks on ECS (EC2) behind an internal ALB that CloudFront reaches
through a VPC origin, RDS PostgreSQL, Mailpit for mail, and a schedule that runs
`reconcile --apply` and `maintain guests` every 5 minutes with an SNS alert on
failure. One `terraform apply` builds and pushes the image, runs `db-bootstrap`
and `migrate`, and publishes the SPA.

It costs about $3.50 a day while it is up, so destroy it when you are done. It
is for development only; the README lists what production would change.

Without a domain it serves from `https://<id>.cloudfront.net`. To use a domain
whose Route 53 zone is in your account, copy
`local.auto.tfvars.example` to `local.auto.tfvars` (gitignored) in
`environments/development` and set `domain_name` there.

```bash
cd infrastructure/terraform/environments/development
terraform init
terraform plan -var-file=terraform.tfvars.development -out=dev.tfplan
terraform apply dev.tfplan
terraform output -raw site_url
terraform destroy -var-file=terraform.tfvars.development
```

Needs Terraform 1.12, Docker, the AWS CLI with the Session Manager plugin, and
AWS credentials. Prerequisites, the optional domain, verification commands,
the Mailpit tunnel, one-off tasks, the schedule and teardown are in
[infrastructure/terraform/README.md](infrastructure/terraform/README.md). The
last recorded runs: [Proven on AWS](docs/terraform/DESIGN.md#proven-on-aws).

## 10. Windows (PowerShell)

`scripts/win64/dev.ps1` covers the basic development flow only: no HTTPS,
certificates, deployment or browser-test setup. Its actions are `init-env`,
`database`, `migrate`, `status`, `generate`, `run`, `reconcile`, `fixtures`,
`fixture-check`, `fixture-run`, `fixture-remove`, `test`, `integration` and
`check`. On Windows, fixtures are still `dev.ps1` actions; there is no
`fixture.ps1` or `connect.ps1`. Run it from any folder; it switches to the repository root itself.

```powershell
./scripts/win64/dev.ps1 init-env
./scripts/win64/dev.ps1 database
./scripts/win64/dev.ps1 migrate
./scripts/win64/dev.ps1 status
./scripts/win64/dev.ps1 run

Invoke-WebRequest http://127.0.0.1:8080/health/live
Invoke-WebRequest http://127.0.0.1:8080/health/ready

./scripts/win64/dev.ps1 fixtures
./scripts/win64/dev.ps1 fixture-run -Fixture <id>
./scripts/win64/dev.ps1 fixture-remove -Fixture <id>

./scripts/win64/dev.ps1 generate
./scripts/win64/dev.ps1 check
./scripts/win64/dev.ps1 test -Race
./scripts/win64/dev.ps1 integration -Race

./scripts/win64/dev.ps1 reconcile -Limit 100          # dry run
./scripts/win64/dev.ps1 reconcile -Apply -Limit 100
```

The frontend `npm` commands are the same on Windows.

## 11. Configuration and troubleshooting

`.env` (git-ignored, created by `init-env`) holds the keys listed in
`.env.example`. Never commit or print real values.

| Key | Purpose |
|---|---|
| `APP_ENV` | `local` or `production` |
| `HTTP_ADDR` | API bind address; default `127.0.0.1:8080`. Local mode requires loopback |
| `FRONTEND_ORIGIN` | Exact browser origin for CORS and email links; default `http://localhost:5173` |
| `POSTGRES_PORT` | Host port; default 5432 |
| `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `APP_DB_PASSWORD` | Bootstrap, migration and runtime roles. Applied only when the volume is first created; rotate them with SQL, never by deleting the volume |
| `JWT_SECRET_BASE64` | At least 32 random bytes, base64 encoded |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | Unset: HTTP. Set both to serve HTTPS; required in production |
| `STATIC_DIR` | A built frontend directory to serve from the API origin |
| `MAIL_MODE`, `SMTP_*`, `MAIL_FROM` | `disabled` locally by default; see [Operations](docs/backend/OPERATIONS.md#email) |
| `TRUSTED_PROXY` | Unset: rate limits use the TCP peer and ignore forwarding headers. `cloudfront` (production only): use `CloudFront-Viewer-Address` |
| `RATE_LIMIT_STORE` | `memory` (default, per process) or `postgres` (shared by several API tasks; a database error refuses the request) |
| `METRICS_ADDR`, `OTEL_*` | Unset: no telemetry. Pass them for one run rather than in `.env`; see [Operations](docs/backend/OPERATIONS.md#telemetry) |

The frontend calls `http://localhost:8080/api/v1` by default. To change it, set
`VITE_API_BASE_URL` in `frontend/.env.local`: an absolute URL ending in
`/api/v1` (HTTPS unless loopback), or exactly `/api/v1` for a same-origin build.

| Symptom | Check |
|---|---|
| `/health/live` is 200 but `/health/ready` is 503 | Is the database reachable, and does `bash scripts/dev.sh status` show version 16? |
| Database authentication fails | The `.env` passwords must match the roles created when the volume was first initialized |
| Port already in use, or `HTTP listener failed` | Another `run` or `serve-https` may still be running (`ss -ltnp \| grep 8443`); or change `POSTGRES_PORT` / `HTTP_ADDR` consistently |
| Browser sign-in returns 403 | The origin must match `FRONTEND_ORIGIN` exactly; use `localhost` on both sides |
| `serve-https` pages load but the cart is disabled | Open exactly `https://localhost:8443`, not `127.0.0.1` |
| `npm ci` fails with `EBADENGINE` | The shell isn't on Node 24.20.0 (`nvm use 24.20.0`) |
| Browser tests crash at random points | Check host stability first: on the development machine, faulty CPU cores caused crashes that looked like test failures |

## 12. More detail

| Topic | Document |
|---|---|
| Deployment profile, image, migrations, email, pruning | [Operations](docs/backend/OPERATIONS.md) |
| Fixture data and lifecycle rules | [Fixtures](docs/frontend/FIXTURES.md) |
| Test groups, harness and when to run what | [Frontend testing](docs/frontend/TESTING.md), [Backend testing](docs/backend/TESTING.md) |
| Release 1.0.0: contents, evidence and known limits | [RELEASE.md](docs/RELEASE.md) |
| Design decisions and trade-offs | [DECISIONS.md](docs/DECISIONS.md) |
| AWS development stack (Terraform) | [Terraform README](infrastructure/terraform/README.md), [design](docs/terraform/DESIGN.md), [cost](docs/terraform/COST.md) |
