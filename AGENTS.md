# Agent guide

Project 1 of the Commerce Reliability Lab: a Go API, a React SPA and PostgreSQL, built to stay correct under failure, released as one container image (`ghcr.io/mleager/ecom-base`). Later portfolio projects run that image unchanged, so behaviour, metric names and the HTTP contract are interfaces, not internals. Start with [docs/README.md](docs/README.md) for the overview and [docs/DECISIONS.md](docs/DECISIONS.md) for the reasons behind the design.

## Layout

| Path | Contents |
|---|---|
| `backend/cmd/` | Binaries: `api`, `migrate`, `db-bootstrap`, `reconcile`, `maintain`, `fixtures` |
| `backend/internal/` | `auth`, `checkout`, `commerce`, `platform` (config, HTTP server, telemetry, database), `db/queries` (SQL) and `db/sqlc` (generated; never edit) |
| `backend/migrations/` | goose SQL migrations, forward only |
| `frontend/src/` | `app` (shell, routing), `features/*`, `shared/api` (the one typed API boundary), `shared/ui` |
| `frontend/tests/` | Playwright: `e2e` (real API and database per test), `e2e-https`, `deploy` |
| `infrastructure/terraform/` | AWS development stack: one root in `environments/development`, modules per layer |
| `scripts/` | `dev.sh` (setup, run, tests, deployment), `fixture.sh`, `certs.sh`, `release-evidence.sh` |
| `docs/` | Design docs by area: `api/`, `backend/`, `frontend/`, `terraform/` |

## Commands

Run from the repository root. Go uses `GOTOOLCHAIN=local`; the frontend needs Node 24.20.0 and npm 11.19.0 (`npm ci` only). [HOW_TO.md](HOW_TO.md) has every command.

| Purpose | Command |
|---|---|
| Format, generate check, vet, vulnerabilities, Go unit tests | `bash scripts/dev.sh check` |
| Go integration tests (needs the database) | `bash scripts/dev.sh integration --race` |
| Regenerate sqlc code after changing SQL | `bash scripts/dev.sh generate` |
| Frontend type check, unit tests, build | `cd frontend && npm run typecheck && npm test && npm run build` |
| Browser tests (needs PostgreSQL and `.env`) | `cd frontend && npm run test:e2e` (or one group, `test:e2e:checkout` etc.) |
| Packaged deployment, end to end | `bash scripts/dev.sh deploy-verify` |
| Terraform | `terraform fmt -check -recursive infrastructure/terraform` and `terraform validate` |

Browser tests are heavy: run one suite at a time, and never the browser and integration suites together.

## Rules that must hold

- **Checkout guarantees** ([docs/backend/CHECKOUT.md](docs/backend/CHECKOUT.md)): no overselling; one idempotency key is one order forever; each reservation settles exactly once; a lost reply is *unknown*, never a rollback.
- **Frontend writes are send-once.** Never add automatic retries or replays of a mutation; uncertain outcomes are resolved by a fresh read.
- **Migrations are forward-only and must work with the previous release's code** (expand, then contract in a later release). Raise `MinSchemaVersion` only with a new migration.
- **The runtime database role is least-privilege.** A new column the API writes needs a grant in a migration.
- **Contracts are versioned.** Changing operations in `docs/api/openapi.yaml` or metrics in `docs/backend/OBSERVABILITY.md` is a contract change; renames are breaking.
- **Dependencies:** exact pins only, versions at least two weeks old, images pinned by digest.
- **Secrets:** never read values from `.env*` or `.cache/` (fixture bundles, certificates) into code, docs, logs or output. `VITE_*` values are public.
- **Ask first** before anything that touches AWS, pushes, publishes an image or sends real mail.

## Docs that tests read

Keep these formats intact when editing:

- `docs/backend/OBSERVABILITY.md`: the metric table rows are parsed by `backend/internal/platform/telemetry/contract_test.go`, and the "Contract version" line by `scripts/release-evidence.sh`.
- `docs/frontend/API_INTEGRATION.md`: its section headings and 4-cell operation rows are parsed by `frontend/src/shared/api/contracts.test.ts`.
- `docs/api/openapi.yaml`: its `info.version` is read by `scripts/release-evidence.sh`.
