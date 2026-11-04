# Milestone 4 — Recovery Verification

**Date:** 2026-10-19 (America/New_York).  
**Scope:** Explicit recovery command, read-only discovery/diagnostics, pending/processing recovery, concurrency and process-crash safety. Milestones 1–4 are complete; frontend and final full-project exit criteria remain outstanding. See [PROJECT_STATUS.md](../PROJECT_STATUS.md) and [operator instructions](../RECOVERY.md).

## Implementation and boundaries

The native `backend/cmd/reconcile` command defaults to dry-run. It validates mode/limit flags and explicit APP_ENV/DATABASE_URL, shares the existing database TLS policy, and needs no JWT secret or HTTP/frontend settings. PowerShell/Bash scripts load local configuration and use runtime credentials. The command never migrates, resets data or starts containers.

Dry-run captures one database cutoff, bounded ordered candidates and global diagnostics in a REPEATABLE READ READ ONLY snapshot. Apply captures cutoff/diagnostics read-only, then uses short READ COMMITTED SKIP LOCKED selections and an expiry/UUID cursor. Visited failures/corruption consume the limit; skipped earlier rows can be considered next run. Pending attempts are claimed and committed; processing attempts are explicitly re-derived. Evaluation holds no transaction/connection, and T2 reuses the Milestone 3 graph guards and exactly-once state/history/inventory changes.

Uncertain claim/T2 COMMIT acquires an independent healthy pooled connection and the same ordered graph locks within one separate second. Full graph/counter validation prevents corrupt terminal state from being accepted as success. Known processing after uncertain claim can be resumed by this explicit operation; unresolved/still-pending claim and unresolved T2 are reported uncertain for a later run. Unknown states are not asserted in audit events. No blind same-call replay of unknown T2 occurs.

Global diagnostics use numeric item arithmetic, distinct entity/rule findings and an exact total with at most 100 returned examples. They cover reserved aggregates, missing inventory/reservations, item/reservation product/quantity/deadline/state links, item/order bounds and totals, order deadlines, and payment cardinality/scenario/reference/state/timestamps. Apply retains initial findings even when unrelated healthy orders complete. It never repairs counters or force-releases expired holds.

JSONL events and summary omit credentials, customer names/shipping data, SQL and raw simulator errors. Unsuccessful configuration, operation, integrity, uncertainty, output or cancellation outcomes exit nonzero. Run/candidate contexts are bounded; state remains recoverable after interruption. Schema/readiness remain **9**: existing grants suffice, and no table, index, migration, runtime dependency or infrastructure component was added.

## Observed environment

| Component | Observed |
|---|---|
| Native Go | go1.25.1 windows/amd64 |
| Native goose | v3.27.1 |
| Native sqlc | v1.31.1 |
| PostgreSQL | 16.13, schema 9 |
| Image | `postgres:16-alpine` |
| Resolved digest | `postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416` |

Only the existing PostgreSQL container was used. Tests create/own random disposable databases, run local goose up/no-op up, and clean up their own databases. Foundation tests retain their disposable migration down/reapply checks. No development data reset, down migration or recovery apply was performed. Localhost tests, child process tests, image inspection and the read-only development check used approved outside-sandbox commands. Git Bash syntax validation required outside-sandbox execution after its DLL initialization failed inside the sandbox; native Linux/macOS behavior was not tested.

## Executed checks

| Command/check | Observed |
|---|---|
| `./scripts/dev.ps1 check` | Passed gofmt, sqlc vet/generation consistency, goose validation, go vet and native tests |
| `./scripts/dev.ps1 integration -Race` | Passed every package and previous milestone tests plus all recovery tests |
| Recovery repetition command below | Passed every recovery test three additional times |
| `go build -o bin/ecom-api.exe ./backend/cmd/api` | Passed |
| `go build -o bin/ecom-reconcile.exe ./backend/cmd/reconcile` | Passed |
| PowerShell AST parse of `scripts/dev.ps1` | Passed |
| Git Bash `-n scripts/dev.sh` | Passed |
| `./scripts/dev.ps1 reconcile -Limit 1` | Read-only development smoke check passed: mode dry-run, limit 1, visited 0, diagnostic_count 0 |
| Native versions and Docker image inspection | Matched the environment above |

Repetition command, executed in the same PowerShell process after the development script loaded test configuration:

```powershell
go test -race -tags=integration -run '^TestRecovery' -count=3 ./backend/internal/platform/integration
```

Final full race run:

```text
ok  ecom/backend/internal/auth                  2.198s
ok  ecom/backend/internal/checkout              1.419s
ok  ecom/backend/internal/commerce              1.214s
ok  ecom/backend/internal/platform/config       1.161s
ok  ecom/backend/internal/platform/httpjson     1.239s
ok  ecom/backend/internal/platform/httpserver   1.251s
real PostgreSQL server 16.13; schema version 9
PASS TestRecoveryApply                         3.38s
PASS TestRecoveryConcurrency                   1.25s
PASS TestRecoveryRollback                      0.32s
PASS TestRecoveryCommand                       2.08s
PASS TestRecoveryProcessCrash                  1.79s
PASS TestRecoveryCommitUncertainty             4.92s
PASS TestRecoveryRetries                       1.93s
PASS TestRecoveryDiscovery                     0.33s
PASS TestRecoveryDiagnostics                   3.83s
ok  ecom/backend/internal/platform/integration  55.545s
ok  ecom/backend/internal/reconcilecmd          1.455s
```

Three additional recovery-suite repetitions:

```text
ok  ecom/backend/internal/platform/integration  63.015s
```

Raw run logs and the development dry-run output are in ignored `.cache/milestone4-*.log` / `.cache/milestone4-development-dryrun.jsonl`. One intermediate sqlc vet invocation terminated inside its bundled parser; the unchanged command passed on rerun, and final generation/static checks passed. No tool upgrade or Docker tooling workaround was introduced.

## Observed experiments

- Dry-run: three expired orders sharing a timestamp were ordered by UUID, limited to two, and returned unchanged. A nonexpired order was excluded. Full JSON snapshots of orders/items/payments/reservations/inventory/history/idempotency/carts, including timestamps, matched before/after successful and failed-output dry-runs.
- Diagnostics: prepared counter, quantity, deadline, missing-reservation, total, order-deadline, invalid-processing-timestamp and missing-payment corruptions were detected without modification. A 105-product aggregate mismatch returned exactly 105 total findings and only 100 examples. A dry-run snapshot stayed internally consistent while both inspected orders settled concurrently.
- Recovery: both accept/reject scenarios, from pending and already-processing attempts, completed for inactive owners. A simulator hook observed zero acquired pooled connections. Repeat runs visited zero candidates and preserved exact persisted snapshots; expired acceptance confirmed instead of releasing stock.
- Limits/selection: a locked first order was skipped, the next UUID was recovered within limit 1, and a later run recovered the skipped/rest candidates. An order whose deadline moved past eligibility after the captured cutoff remained untouched until the next run. A corrupt candidate consumed the visit limit; with a larger limit the cursor moved past it and completed an unrelated healthy order while returning unsuccessful overall.
- Operators/cancellation: one operator paused outside a transaction after its claim while another resumed and settled the same processing attempt. Both completed without another stock/history change. Thirty orders raced customer cancellations against two recovery runs; each ended cancelled or confirmed with corresponding exactly-once stock/history and zero final holds.
- Interruption/output: a closed audit sink after committed claim left processing/active holds, recoverable on the next run. Cancellation after claim stopped the run without settling and also remained recoverable.
- Rollback: a SQL trigger aborted the second reservation transition in a two-product T2. Prior stock/reservation changes and all terminal state/history rolled back while the separately committed claim remained processing. Removing the fault allowed one successful settlement.
- Retry budgets: claim trigger faults raised 40P01 once or 40001 twice and succeeded after two/three attempts; exhausted 40001 stopped at three, arbitrary P0001 at one. Failed claims left pending state/holds unchanged. Existing T2 retry tests also passed in the full suite.
- Commit-loss: test transport wrapped actual PostgreSQL sockets and targeted recovery claim COMMIT 1 and T2 COMMIT 2. For both, dropping before forward or delaying unfinished COMMIT yielded one uncertain result; dropping after server-observed commit resolved safely. Releasing an unfinished commit and rerunning completed/observed the original order without duplicate stock/history. A terminal reservation corrupted immediately after a lost T2 acknowledgement was refused rather than counted settled.
- Native command: the suite built and executed the real recovery binary. Default dry-run needed no JWT settings and changed nothing; apply/repeat had correct summaries and persisted states. Conflicting modes/malformed limits exited nonzero without echoing sensitive argument values. Injected private SQL errors were absent from output/stderr. Terminal corruption caused diagnostic findings and nonzero exit even with no pending candidates.

### Actual process termination

The race-enabled integration executable runs a child with the production checkout/command logic. Harness-only output pauses and PostgreSQL lock barriers create deterministic kill points; there are no public fault switches. The parent forcibly terminates that owned child process, observes database cleanup, and invokes a fresh recovery command:

| Kill boundary | Observed durable state before restart | Observed after restart |
|---|---|---|
| Child T1 committed, before claim | Pending attempt, active holds, one initial history record | Confirmed/consumed once |
| Recovery claim committed | Processing attempt, active holds, one initial history record | Confirmed/consumed once |
| Second reservation transition blocked during T2 | T2 rolled back completely; processing and all original holds remained | Both products consumed once |
| T2 committed, before command completion/summary | Confirmed/consumed, two history records | No additional mutation |

The partial-T2 test verifies the child backend actually waits on a test advisory barrier after earlier reservation/inventory changes. After killing/releasing it, the backend disappears and rollback is observed before recovery. Each boundary uses two products and verifies on-hand/reserved quantities, final status/history, aggregate reservation consistency and an unchanged full snapshot on another rerun. These tests were included in the three additional repetitions.

## Limits and remaining work

This milestone implements explicit operator recovery. There is no automatic timer, cron, worker, queue, external provider, force cancellation, counter repair or refund. Limits, skipped locks and fixed cutoffs mean another explicit run may still be needed. Diagnostics describe the initial snapshot, and apply may partially complete healthy candidates before reporting failures; nonzero exit never means every operation rolled back.

Frontend builds/E2E, native Linux/macOS execution, final consolidated Project 1 reporting and the complete-project exit criteria remain outstanding. Existing OpenAPI routes were unchanged by this CLI increment; no new HTTP recovery endpoint exists.
