# Development guide

Bash on Linux. Run commands from the repository root unless a step says `frontend/`. Windows equivalents are in `scripts/win64/dev.ps1`.

## Prerequisites

| Need | Check |
|---|---|
| Go 1.26 or newer (1.27.3 verified) | `go version` |
| goose 3.27+, sqlc 1.31.1 and govulncheck 1.9.0 on `PATH` (`go install golang.org/x/vuln/cmd/govulncheck@v1.9.0`) | `goose -version`, `sqlc version`, `govulncheck -version` |
| Docker with Compose, and the pinned `postgres:16-alpine` image already pulled (digest below) | `docker compose version`, `docker image ls postgres` |
| Node 24.20.0 and npm 11.19.0 (exact) | `node -v`, `npm -v` |
| OpenSSL (for `init-env` and `certs.sh`), a C compiler (for `--race`) | `openssl version`, `gcc --version` |

The database step uses `--pull never`. Pull the image yourself if it is missing:

```bash
docker pull postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab
```

## First start

```bash
bash scripts/dev.sh init-env      # creates .env with random secrets; refuses to overwrite
bash scripts/dev.sh database      # starts PostgreSQL and waits for health
bash scripts/dev.sh migrate       # applies migrations 1–13
bash scripts/dev.sh status        # confirm version 13
bash scripts/dev.sh run           # API on 127.0.0.1:8080; Ctrl+C to stop
```

In a second terminal:

```bash
curl -i http://127.0.0.1:8080/health/live
curl -i http://127.0.0.1:8080/health/ready
```

Both return 200 once migrations are applied. Readiness returns 503 while the database is unreachable or the schema is older than version 13.

Then start the frontend:

```bash
cd frontend
npm ci --strict-peer-deps
npm run dev                       # http://localhost:5173
```

Use `localhost` (not `127.0.0.1`) in the browser. The refresh cookie and CORS allowlist require matching host names.

## `scripts/dev.sh` actions

| Action | What it does |
|---|---|
| `init-env` | Create `.env` from `.env.example` with generated passwords and JWT secret |
| `init-deploy-env` | Create `.env.postgres`, `.env.migrate` and `.env.deploy` (mode 0600) for the M16 Compose deployment profile, with new secrets independent of `.env`; refuses to overwrite any of them |
| `deploy` / `deploy-down` | Build the image and start `compose.deploy.yaml` (`up -d --build --wait`), or stop it keeping its volume. With `ECOM_IMAGE` set, run that prebuilt image without building. See [Deployment profile](backend/OPERATIONS.md#deployment-profile). |
| `deploy-verify` | Run the M16 deployment verification in its own Compose project on new volumes, removed afterwards. See [Deployment verification](backend/OPERATIONS.md#deployment-verification). |
| `database` | `docker compose up -d --wait` for PostgreSQL (no TLS; also switches back from `database-tls`) |
| `database-tls` | Same, plus `compose.tls.yaml`: PostgreSQL offers TLS with `.cache/certs/postgres.pem`. See [Database TLS](#database-tls). |
| `database-tls-check` | Opt-in test: `verify-full` connects with the local CA and fails for a wrong host name or an untrusted CA |
| `migrate` / `status` | goose up / status and version, as `ecom_migrator` |
| `generate` | `sqlc generate` |
| `run` | Run the API as `ecom_app` |
| `serve-https` | Build the same-origin frontend, then serve it and the API on `https://localhost:8443` against the development database. See [Local HTTPS run mode](#local-https-run-mode). |
| `reconcile [--dry-run\|--apply] [--limit N]` | Order recovery CLI. See [backend/OPERATIONS.md](backend/OPERATIONS.md#recover-interrupted-orders). |
| `test [--race]` | `go test ./...` |
| `integration [--race]` | PostgreSQL integration tests in throwaway `ecom_foundation_*` databases |
| `check` | gofmt, `sqlc vet`, unchanged generated code, goose validate, `go vet`, `govulncheck` (needs network), `go test` |

Fixture databases have their own script, `scripts/fixture.sh` ([frontend/FIXTURES.md](frontend/FIXTURES.md)), and `scripts/connect.sh` opens `psql` on the development database as `postgres` (any arguments go to `psql`). The three scripts share `scripts/lib/common.sh`. `dev.sh` sets `GOTOOLCHAIN=local` and `GOCACHE=.cache/go-build`, reads `.env` literally (no shell expansion), and builds database URLs itself.

## Daily work

- **Restart:** `bash scripts/dev.sh database`, then `bash scripts/dev.sh run`. Migrate only when new migration files arrive.
- **After SQL changes:** `bash scripts/dev.sh generate`, then commit the regenerated `backend/internal/db/sqlc/` files.
- **Before committing backend work:** `bash scripts/dev.sh check`.
- **Before committing frontend work:** from `frontend/`, run `npm run typecheck`, `npm test` and the affected `npm run test:e2e:<group>`.

## Configuration

`.env` (git-ignored) holds the keys listed in `.env.example`. The important ones are below. Never commit or print real values.

| Key | Purpose |
|---|---|
| `APP_ENV` | `local` or `production` |
| `HTTP_ADDR` | API bind address; default `127.0.0.1:8080`. Local mode requires loopback. |
| `FRONTEND_ORIGIN` | Exact browser origin for CORS and email links; default `http://localhost:5173` |
| `POSTGRES_PORT` | Host port; default 5432 |
| `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `APP_DB_PASSWORD` | Bootstrap, migration and runtime roles |
| `JWT_SECRET_BASE64` | At least 32 random bytes, base64 encoded |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | Unset by default (HTTP). Set both to serve HTTPS; required in production. See [Local HTTPS certificates](#local-https-certificates). |
| `STATIC_DIR` | Unset by default. A built frontend directory (for example `frontend/dist`) to serve from the API origin. |
| `MAIL_MODE`, `SMTP_*`, `MAIL_FROM` | `disabled` locally by default. See [backend/OPERATIONS.md](backend/OPERATIONS.md#email-smtp). |
| `TRUSTED_PROXY` | Unset: per-IP rate limits use the TCP peer, and forwarding headers are ignored. `cloudfront` (production only, behind CloudFront in Milestone 17) uses the IP from `CloudFront-Viewer-Address` and refuses requests without exactly one valid header with 400 `invalid_peer`. |
| `RATE_LIMIT_STORE` | `memory` (the default): request limits are counted in each API process. `postgres`: counted in the database (`rate_limit_buckets`, migration 14) so several API tasks share them; used by the AWS stack. A database error then refuses the request. |
| `METRICS_ADDR`, `OTEL_*` | Unset by default: no telemetry. Pass them on the command line for one run rather than in `.env`, which every `dev.sh` command reads. Browser-test APIs never inherit them. See [backend/OPERATIONS.md](backend/OPERATIONS.md#telemetry-optional) and the [contract](backend/OBSERVABILITY_CONTRACT.md). |

Database passwords are applied only when the volume is first created. Editing `.env` later does not change them. Rotate them with SQL and never by deleting the volume.

The frontend API URL defaults to `http://localhost:8080/api/v1`. To change it, copy `frontend/.env.example` to `frontend/.env.local` and set `VITE_API_BASE_URL`. It must be absolute, end in `/api/v1`, and use HTTPS unless it is loopback; or exactly `/api/v1` when the API serves the frontend from the same origin. `npm run build:same-origin` produces that build in `frontend/dist` (it ignores `.env` files; `npm run build` restores the default). `VITE_*` values are public; never put secrets there.

## Local HTTPS certificates

Needed only for the HTTPS run mode and database TLS (Milestone 14). The default HTTP flow above does not use them. Setting `TLS_CERT_FILE=.cache/certs/server.pem` and `TLS_KEY_FILE=.cache/certs/server.key` in `.env` makes `bash scripts/dev.sh run` serve HTTPS; set `HTTP_ADDR` and `FRONTEND_ORIGIN` to match. A one-command mode arrives in task 7.

```bash
bash scripts/certs.sh
```

This creates a local certificate authority (CA) and two server certificates in the git-ignored `.cache/certs/`:

| File | Use |
|---|---|
| `ca.pem` | The CA certificate. This is the only file a browser or client should trust. |
| `ca.key` | The CA private key (mode 0600). **Keep it private.** Anyone with it can make certificates your browser trusts. |
| `server.pem`, `server.key` | API certificate for `localhost`, `127.0.0.1` and `::1` |
| `postgres.pem`, `postgres.key` | Database certificate for `localhost`, `postgres` and `127.0.0.1` |

The keys are EC P-256. The CA is valid for 10 years and the server certificates for 397 days. The script never overwrites anything: if the full set exists it only verifies it, and a partial set is an error. To regenerate, delete `.cache/certs/` yourself and run the script again (any browser trust must then be redone).

**Trusting the CA in a browser** (optional; only for opening `https://localhost:8443` without warnings):

- **Chrome / Chromium:** Settings → Privacy and security → Security → Manage certificates → Authorities → Import `.cache/certs/ca.pem`, and tick "Trust this certificate for identifying websites". On the command line (needs `libnss3-tools`): `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Commerce Lab Local CA" -i .cache/certs/ca.pem`.
- **Firefox:** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import.
- Remove the CA from the browser when you no longer need it.

`mkcert` is an alternative if you prefer it; point `TLS_CERT_FILE` and `TLS_KEY_FILE` at its files instead.

### Database TLS

```bash
bash scripts/dev.sh database-tls        # recreate the container with TLS (data volume kept)
bash scripts/dev.sh database-tls-check  # verify-full passes; wrong host and untrusted CA fail
bash scripts/dev.sh database            # back to the default container without TLS
```

`compose.tls.yaml` mounts only `postgres.pem` and `postgres.key`; the CA key never enters the container. On each start the container copies the key into place owned by `postgres` with mode 0600, then starts PostgreSQL with `ssl=on` and TLS 1.2 as the minimum. TLS is offered, not required, so the default `sslmode=disable` URLs built by `scripts/dev.sh` keep working either way.

To verify the server, use `localhost` (or `127.0.0.1`) with the local CA:

```text
postgresql://ecom_app:<password>@localhost:5432/ecom?sslmode=verify-full&sslrootcert=/absolute/path/.cache/certs/ca.pem
```

This is the form production mode requires. `scripts/dev.sh run` still builds the `sslmode=disable` URL; the production-mode smoke (Milestone 14 task 9) uses the `verify-full` form.

## Local HTTPS run mode

Runs the app the way it will be deployed: one HTTPS origin, the Go API serving both the built SPA and `/api/v1`.

```bash
bash scripts/certs.sh                         # once
bash scripts/dev.sh serve-https               # https://localhost:8443 on the development database; Ctrl+C to stop
bash scripts/fixture.sh create --https        # or: demo data for this origin; prints an ID
bash scripts/fixture.sh serve [id]            # https://localhost:8443 on that fixture
```

`serve-https` (and `fixture.sh serve`) checks for the certificates and `frontend/node_modules`, then runs `npm run build:same-origin`, which rewrites `frontend/dist`. It then starts the API in local mode with these settings, which override `.env`:

- `HTTP_ADDR=127.0.0.1:8443` and `FRONTEND_ORIGIN=https://localhost:8443`
- `TLS_CERT_FILE` and `TLS_KEY_FILE` pointing at `.cache/certs/server.*`
- `STATIC_DIR=frontend/dist`

`dev.sh serve-https` uses the development database; `fixture.sh serve` uses the fixture's database and JWT secret. A fixture created without `--https` still works there, but its product images point at the Vite origin and will not load (the script warns about this).

- Open `https://localhost:8443` (use `localhost`, not `127.0.0.1`, so cookies and the origin check match). Trust `ca.pem` first ([above](#local-https-certificates)), or the browser shows a certificate warning.
- Cookies are `Secure`. HSTS is not sent in local mode, so the Vite dev server on `http://localhost:5173` keeps working afterwards.
- Email stays as configured in `.env` (normally disabled). Links in sent mail use the HTTPS origin.
- The API rate limits are per process. Restart the server if repeated manual runs hit `429` responses.

## Tests

| Command | Scope | Time |
|---|---|---|
| `bash scripts/dev.sh check` | Backend static checks and unit tests | Short (cached) |
| `bash scripts/dev.sh integration --race` | All PostgreSQL integration tests with the race detector | About 5 minutes |
| `cd frontend && npm test` | 1,373 Vitest unit and component tests (needs Node 24.20.0) | Seconds |
| `cd frontend && npm run test:e2e` | 348 Playwright tests against real Go and PostgreSQL, 4 workers by default (`E2E_WORKERS` sets 1–16) | About 5 minutes |
| `cd frontend && npm run test:e2e:https` | 10 Playwright tests against the API serving the built SPA over TLS on `https://localhost:18443`; needs `scripts/certs.sh` first | About 1 minute |

The browser suite needs PostgreSQL running, `.env` present, Chromium installed, and two ports free per worker: 5173–5176 and 18080–18083 with the default four. Don't run it at the same time as `integration`. On this machine, pin heavy runs with `taskset -c 0-7,10-31` (see Troubleshooting). To install Chromium:

```bash
cd frontend
export PLAYWRIGHT_BROWSERS_PATH="$(cd .. && pwd)/.cache/playwright"
npm exec -- playwright install chromium --only-shell
```

If you set `PLAYWRIGHT_BROWSERS_PATH`, keep it set for every `test:e2e` run. Without it, Playwright uses `~/.cache/ms-playwright`, which is where this machine's Linux Chromium is installed. The repository's `.cache/playwright` holds only the old Windows build, so pointing there without installing first makes every test fail at browser launch.

See [frontend/TESTING.md](frontend/TESTING.md) for groups and harness behavior, and [backend/TESTING.md](backend/TESTING.md) for what the integration suite proves.

## Managing PostgreSQL

```bash
docker compose config --quiet     # validate without printing secrets
docker compose stop postgres      # stop, keep data
docker compose down               # remove container and network, keep the volume
```

The project name is `ecom`; the data volume is `ecom_postgres_data`. Do not add `-v` to `down`, and do not run down-migrations against development data.

## Troubleshooting

| Symptom | Check |
|---|---|
| `live` is 200 but `ready` is 503 | Database reachable? `bash scripts/dev.sh status` shows version 13? |
| Database authentication fails | `.env` passwords must match the roles created when the volume was first initialized |
| Port already in use | Change `POSTGRES_PORT` or `HTTP_ADDR` consistently, or stop the conflicting process |
| API exits with `HTTP listener failed` | The bind address is taken, often by another `run` or `serve-https` still running (`ss -ltnp \| grep 8443`) |
| Browser sign-in returns 403 | Origin must match `FRONTEND_ORIGIN` exactly; use `localhost` on both sides |
| `serve-https` pages load, but Add to cart is disabled and "We couldn't check your session" appears | The page was opened on another address (for example `https://127.0.0.1:8443`). Open exactly `https://localhost:8443`. |
| `serve-https` shows "Guest cart creation could not be confirmed" until "Clear guest session" is chosen | The server predates the `__Secure-` cookie names, and a guest cookie from the HTTP stack on `localhost` is being sent to it. Restart `serve-https` on current code, or clear `localhost` site data. |
| `npm ci` fails with EBADENGINE | The shell is not on Node 24.20.0 (`nvm use 24.20.0`) |
| `node_modules/.bin/*` "Permission denied" | `node_modules` came from Windows. Delete it and run `npm ci` again. |
| Browser tests crash at random points | Check host stability first. On this machine, unstable CPU cores 8–9 caused crashes that looked like test failures; run heavy suites with `taskset -c 0-7,10-31`. |
