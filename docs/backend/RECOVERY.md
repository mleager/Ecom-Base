# Recovering interrupted checkouts

The operator derives the account or guest owner from each locked candidate and uses the shared settlement graph. Guest credentials can expire before an operator recovers an interrupted order. Recovery still depends on the persisted payment scenario and reservation state. [Guest outcome design](GUEST_COMMERCE_DESIGN.md#outcome-handoff-and-observation)

Recovery is an explicit operator action. It completes orders that committed in T1 but did not finish payment processing. It uses the existing deterministic simulator and guarded settlement; it never submits real payments, creates another attempt, or changes a stored scenario.

## Run locally

PostgreSQL must be running and migration 9 applied. The API may remain running. Use the installed local Go binary and the existing development scripts; only PostgreSQL runs in Docker.

For configuration, migration status, health checks and operator credentials, start with the [operator guide](OPERATIONS.md). A fresh terminal needs no previously exported database URL when using the development script.

PowerShell, from the repository root:

```powershell
# Inspect first; the default is also dry-run.
./scripts/dev.ps1 reconcile -Limit 100

# Explicitly recover eligible orders.
./scripts/dev.ps1 reconcile -Apply -Limit 100
```

Bash:

```bash
bash scripts/dev.sh reconcile --dry-run --limit 100
bash scripts/dev.sh reconcile --apply --limit 100
```

These scripts load the ignored root `.env` and construct a local URL using `ecom_app`, never the migration or administrator login. They do not migrate, start containers, or reset data. PowerShell's `-Apply` is supported only with `reconcile`; the race switch is supported only with test actions.

For an explicit environment outside the local script:

```text
go run ./backend/cmd/reconcile --dry-run --limit 100
go run ./backend/cmd/reconcile --apply --limit 100
```

Provide `APP_ENV` (`local` or `production`) and `DATABASE_URL` through process configuration. JWT secrets, HTTP addresses and frontend origins are not required. The API's database URL/TLS policy applies: explicit PostgreSQL credentials and `sslmode=verify-full`, except `sslmode=disable` for explicit local loopback connections. Keep credentials out of command arguments and logs. Runtime database credentials are powerful server-side credentials; only authorized operators should have them.

Use `go run ./backend/cmd/reconcile --help` for flags. Without a mode, the command is read-only. The default limit is 100, allowed range 1–1,000. Specifying both mode flags is rejected, even if one explicitly says `false`. The command has a two-minute context budget, five-second candidate operation budgets, the existing statement/lock bounds, and separately bounded one-second commit resolution/cleanup. Cancellation leaves committed work durable and unfinished attempts available to a later run.

## Eligibility and processing

Each run captures one database cutoff. Candidates are orders still in `pending_payment` with `reservation_expires_at <= cutoff`, ordered by deadline then UUID. The deadline is creation plus 15 minutes. It is a recovery threshold, not permission to release stock or reject payment.

Dry-run reads candidates and global diagnostics in one `REPEATABLE READ READ ONLY` snapshot. It never claims an attempt or modifies timestamps, inventory, reservations, history or idempotency records. Its observations do not promise later ownership: another operator or request can change an order afterward.

Apply first captures cutoff/diagnostics in a read-only snapshot, then visits candidates in short READ COMMITTED transactions. `FOR UPDATE SKIP LOCKED` skips an order held by another writer. Every visited candidate, including inconsistent or failed ones, consumes the limit and advances the run's cursor. Skipped earlier rows and orders expiring after the cutoff can be considered in a later run. Reaching the limit or visiting zero rows does not prove that no other work remains.

A pending attempt is claimed and committed before simulation. An existing processing attempt is explicitly re-derived from its persisted ID/scenario. Both paths release every transaction/connection before evaluation and reuse guarded T2. Acceptance confirms/consumes once; rejection records payment failure/releases once. Already cancelled or settled orders are not ordinary recovery candidates. Inactive customers' durable orders remain recoverable; recovery does not require an active customer session.

Concurrent operators may evaluate the same processing attempt. The simulator has no external side effect, and finalization still changes stock/history once. A customer's cancellation can win only before processing is claimed. GET and identical checkout retries continue to observe status only; they do not invoke recovery.

## Output and exit status

Once inspection/recovery reaches reporting, standard output is JSON Lines: candidate/action events followed by one `summary`. Early flag/configuration/readiness failures can exit before any summary, and abrupt process/output failure can truncate it. Check the exit status and stderr as well as completed stdout events. Events contain order IDs, deadlines and bounded state/code fields, without shipping data, names, tokens, SQL or raw simulator errors.

| Field or event | Meaning |
|---|---|
| `candidate` | Dry-run observed an eligible, structurally valid order |
| `claimed` / `resumed` | Apply committed its short selection/claim transaction before evaluation |
| `settled` | Apply observed a valid terminal result; another concurrent operator may have performed the transition |
| `already_terminal` | A lost selection/claim acknowledgement resolved to a validated terminal order |
| `inconsistent` | Graph/counter validation refused unsafe state; no automatic repair |
| `failed` | An operation failed; inspect current state and rerun when appropriate |
| `uncertain` | Commit outcome could not be resolved within the budget; no status is asserted |
| `visited`, `settled`, `already_terminal`, `inconsistent`, `failed`, `uncertain` | Per-run candidate/result counters, not throughput metrics |
| `diagnostic_count` | Total distinct entity/rule findings in the initial consistent diagnostic snapshot |
| `diagnostic_findings` | First 100 findings, ordered by code/type/ID; compare length with the total to identify truncation |

Healthy inspection or recovery exits 0. Invalid configuration/flags, inconsistent data, failed operations, unresolved outcomes, output failure, or interruption exit nonzero. Healthy dry-run candidates alone are not errors. A zero exit does not mean every eligible order was processed: limits and skipped locks still apply. Diagnostic results describe the initial snapshot, not a second global scan after apply.

Diagnostics cover reserved counters versus active sums, missing inventory/reservations, reservation item/product/quantity/deadline/state links, order totals/bounds/deadlines, and payment cardinality/status/scenario/reference/timestamps. Terminal inconsistencies are reported even though terminal orders are not recovery candidates. Apply can complete unrelated healthy orders while still exiting nonzero for findings. It never guesses how to repair corruption.

## After interruption or an uncertain outcome

A committed claim remains processing; an interrupted T2 rolls back all of its changes. If a COMMIT reply is lost, recovery uses a fresh healthy pooled connection and the same ordered graph locks to wait for the writer and validate current state. It accepts a confirmed terminal result only after full graph validation. Unresolved state remains uncertain, never an assumed rollback. Rerunning the explicit command is safe: it finds pending/processing work or leaves terminal data unchanged.

Review the summary and diagnostics, address infrastructure failures or investigate corrupt data, then run dry-run/apply again as appropriate. There is no force-cancel, counter-repair mode, scheduler, worker, provider integration, or refund behavior. A process killed abruptly may emit no summary; completed events describe committed boundaries, and the next run determines current database state.

Capture PowerShell's `$LASTEXITCODE` immediately after a successful script invocation; a script failure also throws a terminating error, so automated callers must catch/report that failure. Bash callers check the script exit status directly. Prefer an explicitly built recovery binary for automation that needs its native exit code; `go run` can add an `exit status` message on stderr. Keep any captured logs private. Both scripts default to dry-run, and cancellation/output failure never authorizes a compensating counter update.

The implementation choices are in [IMPLEMENTATION_DECISIONS.md](IMPLEMENTATION_DECISIONS.md); executed verification is in [Milestone 4 evidence](evidence/MILESTONE_4_RECOVERY.md).
