# Milestone 3 — Simulated Payment Verification

**Date:** 2026-10-19 (America/New_York).  
**Scope:** Processing claim, local deterministic simulator, atomic T2/cancellation, authenticated checkout/order/payment HTTP. Milestones 1–3 are complete; recovery CLI, frontend and full Project 1 exit criteria remain outstanding. See [PROJECT_STATUS.md](../PROJECT_STATUS.md).

## Implementation

The existing `checkout` service now owns the full synchronous use case. T1 commits the pending order and holds; a short transaction conditionally claims the pending attempt; the simulator evaluates its persisted ID/scenario outside a transaction; T2 atomically changes stock, every reservation, payment/order state and history. Accepted attempts consume physical/reserved stock; rejected attempts release reserved stock and store `simulated_decline`. Pending attempts can instead be cancelled by the owner before the claim. Matching terminal repeats validate the graph and change no inventory/history.

All state writers lock order, payment, reservations in product UUID order, then inventory in product UUID order. Validation checks state/timestamps/scenario/reference, totals, item/reservation links/quantities/deadlines and active reservation sums. It refuses corruption without repairing counters. Recognized 40P01/40001 aborts have at most three transaction attempts; uncertain transport errors never trigger blind transaction replay.

New routes are mounted through the existing active-session authentication/CORS/middleware boundary. They expose safe DTOs and enforce ownership, strict JSON/key/pagination/body bounds, no-store responses and private-data-free logs. Order lists and payment-history reads use consistent read-only snapshots. Repeated checkout keys and GET never invoke simulation or recovery.

After post-T1 interruption, a fresh healthy pooled connection obtains a shared order lock within an independent one-second budget, waiting for unfinished state writers. Known pending state returns 202, known new terminal state 201, and an unresolved checkout outcome 503. Existing-key replay returns 200, including T1 commit-resolution results. Cancellation resolves to known cancelled state (200) or `order_outcome_uncertain` (503), then can be retried for the same order. No stale T1 snapshot is substituted for an unresolved current state.

Migration `00009_settlement_permissions.sql` adds column-scoped state/timestamp/failure-code updates. Existing snapshots, attempt identity/scenario/reference, reservation links/quantities/deadline, history and idempotency remain immutable to runtime updates. No domain table, index or runtime dependency was added.

## Observed environment

| Component | Observed |
|---|---|
| Native Go | go1.25.1 windows/amd64 |
| Native goose | v3.27.1 |
| Native sqlc | v1.31.1 |
| PostgreSQL server | 16.13 |
| Schema/readiness | 9 |
| Image tag | `postgres:16-alpine` |
| Resolved digest | `postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416` |

Go/goose/sqlc/builds/tests ran locally; Docker supplied only the existing PostgreSQL container. Integration fixtures create owned random disposable databases and invoke local goose up/no-op up. Foundation tests also verify disposable down/reapply. Development data was not reset. Localhost access, the development migration and Docker inspection used approved escalated commands.

## Executed checks

| Command | Observed result |
|---|---|
| `./scripts/dev.ps1 check` | Passed gofmt, sqlc vet/generation consistency, goose validate, go vet and unit tests |
| `./scripts/dev.ps1 integration -Race` | Passed every package, including existing foundation/auth/commerce/T1 tests and all new payment/HTTP tests |
| New integration tests, command below | Every new integration test passed three additional times |
| `go build -o bin/ecom-api.exe ./backend/cmd/api` | Passed |
| `./scripts/dev.ps1 migrate` | Applied migration 9 to development successfully |
| `docker image inspect postgres:16-alpine --format '{{json .RepoDigests}}'` | Confirmed the digest above |
| `.cache/openapi-validation/Scripts/python.exe .cache/validate-milestone3-openapi.py` | Existing isolated validator passed OpenAPI 3.0.3, duplicate YAML-key checks, five order/payment state examples, error/request examples and rejection of an extra actor field |

The executed repetition command was:

```powershell
go test -race -tags=integration -run '^Test(Settlement|OrderHTTP)' -count=3 ./backend/internal/platform/integration
```

It ran in the same PowerShell process after `./scripts/dev.ps1 integration -Race` loaded the test environment. Raw run logs and the one-off validation helper live in ignored `.cache/`; they are not application tooling or runtime dependencies. API tests exercise actual HTTP responses with strict typed decoding; the separate OpenAPI example validation is not a claim of automated schema validation for every runtime response.

Final full race run:

```text
ok  ecom/backend/internal/auth                  2.207s
ok  ecom/backend/internal/checkout              1.415s
ok  ecom/backend/internal/commerce              1.231s
ok  ecom/backend/internal/platform/config       1.164s
ok  ecom/backend/internal/platform/httpjson     1.231s
ok  ecom/backend/internal/platform/httpserver   1.231s
real PostgreSQL server 16.13; schema version 9
ok  ecom/backend/internal/platform/integration  36.104s
```

Three additional repetitions:

```text
ok  ecom/backend/internal/platform/integration  58.362s
```

## Observed experiments

- Both scenarios: Process settles once; same-key replay never simulates again; a simulator hook observed zero acquired pool connections during evaluation.
- Twenty concurrent finalizers for each scenario produced one terminal state transition/history entry. Twenty concurrent cancellations likewise released stock once. Thirty independently prepared orders raced claim against cancellation; exactly one ownership decision won for each, with final physical/reserved quantities consistent with the winners.
- One hundred authenticated HTTP customers competed for the last unit behind a start barrier: one confirmed 201, 99 conflicts, final on-hand/reserved 0/0. Each test repetition creates fresh fixtures; these are correctness observations, not throughput measurements.
- Injected SQL failure on the second reservation transition in two-product settlement and cancellation rolled back earlier stock/reservation writes and all state/history. Removing the fault allowed one successful completion.
- Trigger-injected deadlock/serialization failures verified bounded retries; exhausted serialization stopped at three attempts, and arbitrary SQL errors were not retried.
- Test-only PostgreSQL transport wrapping targeted COMMIT 2 (claim) or 3 (T2) after an actual T1. Dropping the claim acknowledgement left processing with 202 and zero simulator calls; dropping before claim commit left pending with 202. Dropping after server-observed T2 commit resolved to confirmed 201; dropping before T2 commit returned known processing 202. Holding unfinished upstream T2 beyond the lookup budget returned 503, then releasing its commit allowed same-key 200 with one settlement.
- Cancellation transport faults closed before COMMIT, dropped a committed reply, or delayed unfinished COMMIT. Responses were respectively 503, 200 and 503. Repeating cancellation after resolution yielded the same cancelled order, one history transition and unchanged physical stock with zero holds.
- Corrupted reservation quantity, inventory aggregate, simulator reference and order totals caused safe integrity refusal in claim/cancellation, with no state/history mutation. A terminal reservation mismatch was rejected instead of accepted as an idempotent settlement. HTTP returned sanitized 500 and a bounded integrity log message.
- HTTP tests cover accepted/declined DTOs, retained intent after address deletion, changed-intent conflict, authentication, cross-owner 404/list isolation, strict keys/body fields, invalid bounds, oversized bodies, cancellation conflicts/repeats, safe logs, stable pagination ties, 202 after simulator interruption and no automatic processing on GET/retry. Blocking simulation allowed concurrent reads of processing state, cancellation conflict and status-only replay before the original request completed.
- An expired acceptance fixture still confirmed and consumed stock. The operational deadline did not force rejection/release.

Every successful transaction experiment checks reserved counters against active reservation sums and verifies order totals, linked reservations, deadlines and retained records through PostgreSQL queries. Tests use actual pgx transactions/runtime credentials; transaction mocks and public fault controls are absent.

## Limits and next work

The explicit recovery CLI, dry-run, SKIP LOCKED candidate ownership, consistent global diagnostics and process-termination/restart experiments belong to Milestone 4. The M3 transport/trigger/interruption tests do not claim those command-level guarantees. Interrupted pending/processing attempts retain active holds; neither polling/retry nor the 15-minute threshold releases them. Production simulator evaluation has no external financial side effect.

Frontend build/E2E, Linux/macOS execution and final full-project correctness reports remain unverified. Restart an older API process after updating so it uses the enabled routes and schema-9 readiness check.
