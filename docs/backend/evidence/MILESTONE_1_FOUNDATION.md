# Milestone 1 — Foundation Verification

**Date:** 2026-10-18 (America/New_York).
**Scope:** Initial database/runtime foundation. Milestone 1 is not complete.

**Historical path note:** This report records the original layout and commands.
On 2026-10-19 Compose moved to root `compose.yaml`; use the current README for
commands. The original verification results below retain their executed paths.

## Environment observed

| Component | Observed version |
|---|---|
| Native Go | go1.25.1 windows/amd64 |
| Native goose | v3.27.1 |
| Native sqlc | v1.31.1 |
| chi dependency | v5.3.1 |
| pgx dependency | v5.10.0 |
| Docker Engine | 28.3.3, Linux through Docker Desktop |
| Docker Compose | v2.39.2-desktop.1 |
| PostgreSQL server | 16.13 |
| PostgreSQL image tag | postgres:16-alpine |
| PostgreSQL image digest | postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416 |

Only PostgreSQL ran in Docker, using the existing local image. No tooling or API
image was built or downloaded. All builds, SQL generation, migration commands,
unit/integration tests, and race checks used the installed local executables.
Windows sandbox restrictions required explicit local Docker/localhost access.

## Executed checks

| Command/check | Observed result |
|---|---|
| `docker compose --env-file .env -f infrastructure/compose.yaml config --quiet` | Passed |
| `docker compose --env-file .env -f infrastructure/compose.yaml up -d --wait --pull never postgres` | Healthy PostgreSQL, loopback port 5432 |
| `./scripts/dev.ps1 migrate` | All five migrations applied; goose version 5 |
| `./scripts/dev.ps1 generate` | Generated catalog queries/models with native sqlc |
| `./scripts/dev.ps1 check` | Formatting, sqlc vet/generation consistency, goose validate, go vet, native unit tests passed |
| `go test -race ./...` | Passed |
| `./scripts/dev.ps1 integration` | Passed against an owned disposable database |
| `./scripts/dev.ps1 integration -Race` | Passed, including native unit and PostgreSQL integration tests |
| `go build -o bin/ecom-api.exe ./backend/cmd/api` | Passed |
| Schema-to-migration comparison | All 13 CREATE TABLE and 10 explicit CREATE INDEX statements match the specification |

The final race/integration run reported:

```text
ok  ecom/backend/internal/platform/config       1.277s
ok  ecom/backend/internal/platform/httpserver   1.419s
ok  ecom/backend/internal/platform/integration  2.377s
real PostgreSQL server 16.13; schema version 5
```

Timings are observations from this run, not performance targets or throughput
claims. Command scripts set `GOTOOLCHAIN=local` and use a project-local build cache.

## What the tests establish

- Configuration rejects invalid modes, weak/malformed configured secret lengths,
  missing credentials, insecure nonlocal database connections, connection-host
  overrides, and public bindings in local mode. Error text does not expose the
  supplied password.
- Root liveness is independent of the database. Readiness has a deadline and
  returns a safe 503 when dependencies are unavailable. Panic/error responses and
  logs do not expose internal exception text, query strings, or supplied secrets.
- All 13 domain tables plus goose metadata exist after migration. Runtime
  credentials cannot create schema objects or update goose version metadata.
- Generated catalog queries return active products with derived availability,
  omit retired products, and represent an empty page as an empty slice.
- PostgreSQL rejects representative noncanonical/duplicate emails, negative or
  overreserved inventory, negative prices, invalid cart quantities/versions,
  invalid order statuses/totals/address types, and deletion of referenced products.
- Local goose up succeeds and is a no-op on a second application. Down-to-zero
  and reapply succeed only within the suite's randomly named disposable database.
  HTTP readiness follows those real schema changes.
- Test cleanup removes the database it created; development data is not reset.

## Limitations and observed tooling issue

The installed Windows sqlc executable crashed once in its WASM parser/compiler
with an access violation during generation. Re-running the same local command
succeeded, and the final complete generation/consistency/vet/test check passed.
No installed binary was replaced and no undocumented workaround was added. If
it recurs, investigate the native executable/runtime separately from application
SQL errors rather than suppressing failures.

These checks do not establish authentication, write permissions, CRUD endpoints,
cart locking, checkout, inventory-reservation aggregation, payment settlement,
recovery, or frontend correctness. Those behaviors are not implemented in this
increment. Constraint/query fixtures are database-level experiments, not complete
service-created orders. The API binary was built and handlers exercised by tests;
an interactive API process was not left running. PostgreSQL remains healthy with
its persistent development volume.
