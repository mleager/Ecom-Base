# Development guide

Bash on Linux. Run commands from the repository root unless a step says `frontend/`. Windows equivalents are in `scripts/win64/dev.ps1`.

## Prerequisites

| Need | Check |
|---|---|
| Go 1.25.1 or newer (1.27.3 verified) | `go version` |
| goose 3.27+ and sqlc 1.31.1 on `PATH` | `goose -version`, `sqlc version` |
| Docker with Compose, and the image `postgres:16-alpine` already pulled | `docker compose version`, `docker image ls postgres` |
| Node 24.20.0 and npm 11.19.0 (exact) | `node -v`, `npm -v` |
| OpenSSL (for `init-env` and `certs.sh`), a C compiler (for `--race`) | `openssl version`, `gcc --version` |

The database step uses `--pull never`. Pull the image yourself if it is missing:

```bash
docker pull postgres:16-alpine
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

Both return 200 once migrations are applied. Readiness returns 503 while the database is unreachable or the schema is not version 13.

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
| `database` | `docker compose up -d --wait` for PostgreSQL |
| `migrate` / `status` | goose up / status and version, as `ecom_migrator` |
| `generate` | `sqlc generate` |
| `run` | Run the API as `ecom_app` |
| `reconcile [--dry-run\|--apply] [--limit N]` | Order recovery CLI. See [backend/OPERATIONS.md](backend/OPERATIONS.md#recover-interrupted-orders). |
| `fixtures`, `fixture-check <id>`, `fixture-run <id>`, `fixture-remove <id>` | Disposable demo databases. See [frontend/FIXTURES.md](frontend/FIXTURES.md). |
| `test [--race]` | `go test ./...` |
| `integration [--race]` | PostgreSQL integration tests in throwaway `ecom_foundation_*` databases |
| `check` | gofmt, `sqlc vet`, unchanged generated code, goose validate, `go vet`, `go test` |

The script sets `GOTOOLCHAIN=local` and `GOCACHE=.cache/go-build`, reads `.env` literally (no shell expansion), and builds database URLs itself.

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
| `MAIL_MODE`, `SMTP_*`, `MAIL_FROM` | `disabled` locally by default. See [backend/OPERATIONS.md](backend/OPERATIONS.md#email-smtp). |

Database passwords are applied only when the volume is first created. Editing `.env` later does not change them. Rotate them with SQL and never by deleting the volume.

The frontend API URL defaults to `http://localhost:8080/api/v1`. To change it, copy `frontend/.env.example` to `frontend/.env.local` and set `VITE_API_BASE_URL`. It must be absolute, end in `/api/v1`, and use HTTPS unless it is loopback. `VITE_*` values are public; never put secrets there.

## Local HTTPS certificates

Needed only for the HTTPS run mode and database TLS (Milestone 14). The default HTTP flow above does not use them.

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

## Tests

| Command | Scope | Time |
|---|---|---|
| `bash scripts/dev.sh check` | Backend static checks and unit tests | Short (cached) |
| `bash scripts/dev.sh integration --race` | All PostgreSQL integration tests with the race detector | About 5 minutes |
| `cd frontend && npm test` | 1,366 Vitest unit and component tests | Seconds |
| `cd frontend && npm run test:e2e` | 348 Playwright tests against real Go and PostgreSQL | About 19 minutes |

The browser suite needs PostgreSQL running, `.env` present, ports 5173 and 18080 free, and Chromium installed:

```bash
cd frontend
export PLAYWRIGHT_BROWSERS_PATH="$(cd .. && pwd)/.cache/playwright"
npm exec -- playwright install chromium --only-shell
```

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
| Browser sign-in returns 403 | Origin must match `FRONTEND_ORIGIN` exactly; use `localhost` on both sides |
| `npm ci` fails with EBADENGINE | The shell is not on Node 24.20.0 (`nvm use 24.20.0`) |
| `node_modules/.bin/*` "Permission denied" | `node_modules` came from Windows. Delete it and run `npm ci` again. |
| Browser tests crash at random points | Check host stability first. On this machine, unstable CPU cores 8–9 caused crashes that looked like test failures. |
