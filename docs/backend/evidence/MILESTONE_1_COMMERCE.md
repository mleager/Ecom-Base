# Milestone 1 — Account, Catalog and Cart Verification

**Date:** 2026-10-18 (America/New_York).  
**Scope:** Remaining Milestone 1 backend features. Combined with the foundation and authentication increments, Milestone 1 is complete. Project 1 remains in progress; see [PROJECT_STATUS.md](../PROJECT_STATUS.md).

## Implemented behavior

- Partial profile updates; owned saved-address create/list/update/delete; strict US state/DC and ZIP/ZIP+4 validation; explicit optional-text clearing.
- Anonymous active catalog browsing with deterministic pagination; admin-only product creation/update/soft retirement/reactivation and signed inventory adjustments.
- Product and zero-stock inventory creation in one transaction. Stock changes lock inventory and preserve `quantity_on_hand >= quantity_reserved >= 0` without writing reservations.
- Cart read/add/replace/remove/clear with parent-row locks, coherent item/version snapshots, one increment per successful change and quantity/distinct-product/JSON-safe version bounds. Cart changes neither reserve inventory nor require stock.
- Migration 7 with column-scoped feature grants; schema remains 13 domain tables plus goose metadata. Runtime cannot change roles/activation, ownership, reservation counters, goose metadata or physically delete products.
- Shared strict JSON parsing and existing authentication/CORS integration. No new Go runtime dependencies or infrastructure services.

## Observed environment

| Component | Observed |
|---|---|
| Native Go | go1.25.1 windows/amd64 |
| Native goose | v3.27.1 |
| Native sqlc | v1.31.1 |
| PostgreSQL | 16.13 |
| Schema | 7 |
| PostgreSQL image | `postgres:16-alpine` |
| Resolved digest | `postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416` |

Only the existing PostgreSQL container was used. Go builds/tests, sqlc and goose ran locally. Sandbox restrictions required explicit localhost/Docker-inspection access. No development data was reset; down/reapply occurred only in randomly named disposable databases owned by the integration harness.

## Executed checks

| Command | Result |
|---|---|
| `./scripts/dev.ps1 check` | Passed gofmt, sqlc vet/generation consistency, goose validate, go vet and native unit tests |
| `./scripts/dev.ps1 integration -Race` | Passed all unit, authentication, commerce and foundation integration tests |
| `go test -race -tags=integration -run '^TestCommerce$' -count=3 ./backend/internal/platform/integration` | Passed three repetitions, each with a fresh disposable database |
| `go build -o bin/ecom-api.exe ./backend/cmd/api` | Passed |
| `./scripts/dev.ps1 migrate` | Applied `00007_core_api_permissions.sql` to the development database; goose version 7 |
| `docker image inspect postgres:16-alpine --format '{{json .RepoDigests}}'` | Confirmed the digest above |
| `./.cache/openapi-validation/Scripts/python.exe -m openapi_spec_validator docs/api/openapi.yaml` | OpenAPI 3.0.3 document: OK |
| OAS30Validator concrete response examples | Address, Product, Inventory and Cart boundary examples: OK |

OpenAPI verification used `openapi-spec-validator` 0.7.2 and `openapi-schema-validator` 0.6.3 inside an ignored local Python virtual environment under `.cache/openapi-validation`; these are document-checking tools, not application dependencies. Concrete schema examples are illustrative values, while the native HTTP tests exercise actual responses and strictly decode their DTO fields. Schema verification does not claim automatic validation of every future endpoint against OpenAPI.

Final full race run:

```text
ok  ecom/backend/internal/auth                  2.185s
ok  ecom/backend/internal/commerce              1.207s
ok  ecom/backend/internal/platform/config       1.156s
ok  ecom/backend/internal/platform/httpjson     1.221s
ok  ecom/backend/internal/platform/httpserver   1.223s
real PostgreSQL server 16.13; schema version 7
ok  ecom/backend/internal/platform/integration  6.680s
```

Repeated commerce suite:

```text
ok  ecom/backend/internal/platform/integration  6.579s
```

Timings describe these test runs, not throughput or performance guarantees. Full verbose output from the final all-package run is in the ignored `.cache/milestone1-integration.log` in this workspace.

## What the tests establish

- Profile PATCH preserves protected/omitted fields; concurrent changes to different name fields both persist. Empty/null/unknown/duplicate/case-alias/type-invalid/oversized JSON is rejected with the intended status.
- Saved addresses are scoped to the caller in SQL; another user cannot list/update/delete them. Omitted values survive PATCH, empty optional text becomes SQL NULL and serializes as empty text, invalid states/ZIP/country are rejected, and lists retain creation/ID order.
- Catalog responses decode into the strict documented DTO shapes; public pagination and active-product visibility work. Customers cannot invoke admin operations. Duplicate SKUs return 409, retirement hides products without deleting data, reactivation and zero/maximum prices work.
- An injected inventory-insert failure leaves no orphan product. SQL exception details do not appear in the HTTP error.
- Twenty barrier-start stock adjustments preserve all deltas and the reservation counter. Decrements below reservations and increments beyond SQL INTEGER fail without changing stock; the exact maximum is accepted. Operator-only reservation fixtures test the reserved floor and are isolated to disposable databases.
- Cart POST adds and PATCH replaces. Unchanged quantity and clearing an empty cart each increment once. Foreign/missing item mutation returns 404 and preserves the caller's version. Retired products cannot receive added/replacement quantities but remain removable.
- Thirty barrier-start additions to the same cart produce one item with quantity 30 and exactly 30 distinct version increments; each returned item snapshot matches its version. An independent transaction holding the cart lock blocks both reads and writes, and cancellation leaves no change.
- Injecting failure on the version update rolls back the preceding item insertion. Capacity rejects a 101st distinct product while allowing an existing product to increase. The final safe version is accepted; subsequent add/replace/remove/clear attempts return `cart_version_exhausted` and roll back every item change.
- Feature routes retain exact-origin CORS/no-store behavior; preflight works without credentials, and an untrusted origin is denied.
- Runtime SQL privileges deny ownership reassignment, role/activation changes, reservation-counter updates, physical product deletion and goose metadata writes. Existing authentication and schema constraints still pass; goose up/no-op/down-to-zero/reapply succeeds in disposable databases.

The first unrestricted integration run exposed a capacity-fixture setup error: pgx does not accept multiple parameterized commands in one prepared statement. Splitting setup statements fixed the fixture; the subsequent full and repeated suites passed. The initial sandbox-only run could not reach localhost and is not counted as PostgreSQL verification.

## Limits and next work

Checkout T1, processing/payment simulation/T2, order APIs, cancellation and recovery are not implemented or verified by this milestone. Cart price multiplication/summation and last-unit checkout contention are later checks. The frontend and Linux/macOS execution were not verified. No claim is made that the full Project 1 exit criteria are satisfied.
