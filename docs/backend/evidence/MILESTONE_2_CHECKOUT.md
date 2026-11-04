# Milestone 2 — T1 Checkout Verification

**Date:** 2026-10-19 (America/New_York).  
**Scope:** Complete service-layer T1 pending-order creation, not payment processing or checkout HTTP. Milestones 1 and 2 are complete; the full Project 1 exit criteria remain outstanding. See [PROJECT_STATUS.md](../PROJECT_STATUS.md).

## Implementation

The five planned steps are implemented as one `checkout.Service.CreatePending` operation, with request/intent/numeric unit tests and real transaction tests added in reviewable increments. It validates the trusted actor and strict key/version/scenario rules; checks retained intent before mutable source data; serializes first uses with the specified advisory lock; locks the persistent cart; reads authoritative snapshots; validates money; holds inventory in ascending UUID order; inserts the order/items/reservations/initial attempt/history/idempotency record; clears the cart and increments its version; and commits atomically.

Identities survive recognized transaction retries. A retained result returns current consistent order/payment state without processing. PostgreSQL-confirmed aborted transactions are retried at most three times for 40P01/40001 only. Uncertain COMMIT is resolved through an independent healthy pooled connection with the same advisory lock; lookup cannot mistake an unfinished T1 for rollback. A separate bounded one-second lookup survives request cancellation. Missing/unresolved records remain uncertain and are never automatically recreated by the same call.

Migration 8 adds column-scoped T1 insertion and reserved-counter writes, without changing the 13-table schema or its initial indexes/constraints. Runtime cannot rewrite snapshots/idempotency/history or transition payments/reservations. Service errors await HTTP mapping in Milestone 3; checkout/order HTTP routes remain disabled (404/405).

## Observed environment

| Component | Observed |
|---|---|
| Native Go | go1.25.1 windows/amd64 |
| Native goose | v3.27.1 |
| Native sqlc | v1.31.1 |
| PostgreSQL server | 16.13 |
| Schema | 8 |
| Image tag | `postgres:16-alpine` |
| Resolved digest | `postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416` |

Go/goose/sqlc/builds/tests ran locally. Only the existing PostgreSQL container was used. No runtime dependency, domain table, external provider, queue, worker or tooling container was added. Sandbox localhost/Docker-inspection access required explicit approval. Test databases have random owned names, clean migrations and cleanup; no development data reset or down migration occurred.

## Executed checks

| Command | Observed result |
|---|---|
| `./scripts/dev.ps1 check` | Passed gofmt, sqlc vet/generation consistency, goose validate, go vet and unit tests |
| `./scripts/dev.ps1 integration -Race` | Passed all packages, including existing auth/commerce/foundation tests and all new checkout tests |
| `go test -race -tags=integration -run '^TestCheckout' -count=3 ./backend/internal/platform/integration` | All T1/retry/commit-loss tests passed three additional times |
| `go build -o bin/ecom-api.exe ./backend/cmd/api` | Passed |
| `./scripts/dev.ps1 migrate` | Applied `00008_checkout_permissions.sql` to development; schema version 8 |
| `docker image inspect postgres:16-alpine --format '{{json .RepoDigests}}'` | Confirmed the digest above |

Final full race run:

```text
ok  ecom/backend/internal/auth                  2.210s
ok  ecom/backend/internal/checkout              1.211s
ok  ecom/backend/internal/commerce              1.211s
ok  ecom/backend/internal/platform/config       1.150s
ok  ecom/backend/internal/platform/httpjson     1.227s
ok  ecom/backend/internal/platform/httpserver   1.227s
PASS TestCheckoutRetries                       2.11s
PASS TestCheckoutCommitUncertainty             2.51s
PASS TestCheckout                              5.48s
real PostgreSQL server 16.13; schema version 8
ok  ecom/backend/internal/platform/integration  16.906s
```

Three additional checkout-suite repetitions:

```text
ok  ecom/backend/internal/platform/integration  33.537s
```

Timings are observations, not throughput claims. The final full verbose log is in ignored `.cache/milestone2-integration.log` in this workspace. The foundation suite also verifies up/no-op/down-to-zero/reapply and runtime readiness on its own disposable database at schema 8.

## Requirements exercised

| Requirement | Test/evidence |
|---|---|
| T1 complete atomic graph | One pending order, item/reservation per product, exactly one pending attempt, initial history and retained intent; cart empty/version advanced |
| ORD-01 immutable snapshots | Price/name/SKU/address snapshots remain unchanged after product edits/retirement, address deletion and later cart clears |
| ID-01 same key/same intent | 20 barrier-start requests return one order; exactly one new result and 19 replays |
| ID-02 changed intent | Version/address/scenario changes conflict; simultaneous accept/reject intents serialize to one winner and one conflict |
| ID-03 two keys/one cart version | Exactly one new order and one stale-cart error |
| INV-01 last-unit contention | 100 customers start together; exactly one order/hold and 99 inventory conflicts; losing cart versions remain unchanged |
| INV-02 held aggregate consistency | Read-consistent SQL compares each reserved aggregate with active reservations and verifies item/product/quantity/expiry links |
| CART-02 checkout/cart isolation | Concurrent cart add and T1 produce a valid serial outcome with matching quantity/version snapshots |
| Ordered multi-product locks | Carts populated in opposite product orders both complete with consistent stock holds |
| TX-01 partial rollback | Second UUID lacks stock after first hold; late idempotency insertion fails; cart-version update fails after clear; no partial graph, held stock or consumed cart survives |
| TX-04 known committed lost reply | Actual PostgreSQL COMMIT completes; transport discards acknowledgement; independent lookup returns the same durable pending order |
| TX-04 before-commit loss | Transport closes before forwarding COMMIT; call conservatively returns outcome uncertainty; identical retry safely creates once after rollback |
| TX-04 unfinished upstream | Transport retains the upstream transaction/locks while downstream loses acknowledgement; lookup times out as uncertain, then later retry returns its eventual single commit |
| Request cancellation | Commit acknowledgement loss cancels the request; bounded independent lookup still resolves the known durable order |
| Retry rules | PostgreSQL trigger faults produce 40P01/40001; retries succeed within three attempts; exhausted budget stops at three; arbitrary SQL error stops at one |
| COMMIT-time abort | Deferred constraint trigger raises 40001 at COMMIT; acknowledged abort is safely retried, with one final graph/hold |
| NUM-01 bounded money/cart | Invalid multiplication/subtotal rejected before holds, maximum total accepted, 101 lines rejected, 100 zero-price lines with quantity 10,000 accepted, exhausted cart version rejected |
| SEC-01 ownership/current actor | Foreign address denied, unknown/inactive actor denied, inactive product denied |
| Read-only replay semantics | Operator-prepared processing state is returned without processing; inconsistent order/payment pair fails integrity validation |
| Immutable runtime permissions | Order/item rewrites, payment/reservation transitions, idempotency/history deletion denied; earlier role/ownership restrictions still pass |
| No partial HTTP feature | Production-equivalent router wiring still rejects checkout/order paths with 404/405 |

Every additional repetition includes its own 100-customer, 20-same-key, rollback, retry and connection-loss experiments. The pool is the configured ten-connection runtime pool; these counts describe competing service calls rather than 100 simultaneous database connections.

## Fault methodology and practical limits

Tests use PostgreSQL constraints/transactions directly. The test-only pgx `DialFunc` wrapper recognizes the COMMIT protocol packet and can close before forwarding, consume/drop the server's actual COMMIT acknowledgement, or hold the upstream transaction until a test-controlled release. The latter suppresses downstream cancellation/termination to model a partitioned upstream; it never replaces the transaction with a mock. PostgreSQL wire messages verify actual commit completion. Trigger-raised SQLSTATE faults exercise retry classification and budgets; they are deliberate injected aborts, not a claim that ordinary ordered T1 created a real lock-cycle deadlock.

An initial disabled-route test expected only 404; chi's wildcard preflight route produces 405 for unsupported methods, matching the existing documented 404/405 behavior. The assertion was corrected. The first sandbox run could not reach localhost and is not counted as PostgreSQL verification. A test-transport cancellation socket initially waited for pgx cleanup timeout; closing that discarded socket promptly removed the artificial delay. Subsequent full and repeated race suites passed.

There is no implemented payment claim, simulation, T2 settlement, cancellation, recovery command, checkout HTTP or order HTTP in this milestone. Operator-prepared payment state tests only replay reads and integrity rejection; it does not establish settlement correctness. Linux/macOS, frontend flows, process-kill recovery and general network failure modes beyond the controlled commit cases remain unverified. No real payment or eventual recovery guarantee is claimed.
