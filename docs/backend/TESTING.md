# Backend testing

## Strategy

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Transaction and concurrency guarantees are tested against real PostgreSQL, never mocks** | Lock order, constraint violations, `SKIP LOCKED` and lost COMMIT replies only behave correctly against the real engine | Integration tests need Docker and take minutes, not seconds |
| **Each integration test creates its own throwaway database** (`ecom_foundation_<random>`), migrates it and drops it | Tests can run in parallel and never touch development data | Database creation dominates run time |
| **Faults are injected through test-only hooks and a TCP proxy**, never through API flags | The production binary has no fault switches or debug routes | The hooks must be kept in sync with the code paths they interrupt |
| **Missing configuration fails the run instead of skipping tests** | A green run means the tests actually ran | Local runs need the full setup |
| **Concurrency tests must pass repeatedly, with `-race`** | A race that passes once proves nothing | Slower runs |

## Gates

| Command | Proves |
|---|---|
| `bash scripts/dev.sh check` | `gofmt`, `go vet`, `sqlc vet`, generated code up to date, migrations valid, unit tests, and `govulncheck` with no reachable vulnerability |
| `bash scripts/dev.sh integration --race` | Every integration test against PostgreSQL, with the race detector |
| `bash scripts/dev.sh deploy-verify` | The built image in production mode: migrations, TLS, database role rules, a browser journey, recovery inside the deployment, restart, telemetry |

## Key experiments

| Experiment | Assertion |
|---|---|
| Last-item contention | 100 concurrent checkouts for 1 unit produce exactly one reservation and no negative stock |
| Retry after the cart is cleared | The same key and body returns the same order; a changed body returns 409 |
| Two keys, one cart version | One order; the other request gets `stale_cart` |
| T1 rollback | A stock failure on the second item leaves no rows and no stock change |
| Lost COMMIT reply (T1, claim, T2, cancel) | Real packet faults through a proxy: at most one order, no double settlement, the specified status |
| Process killed after T1, after the claim, during T2 | A separate process is killed; the next recovery run settles once and a second run changes nothing |
| Two operators running recovery | Each order is settled exactly once; dry-run changes nothing; corrupt state exits non-zero |
| Cancellation racing a claim | Exactly one wins under the order lock |
| Shared rate limits | Two limiter instances on one database admit exactly 20 of 60 concurrent requests |
| Database bootstrap | Three concurrent runs and a rerun leave the same roles, grants and defaults |
| Auth and security flows | Concurrent refresh has one winner, revocation is immediate, a reused refresh token revokes the session, tokens are single-use, and concurrent credential changes conflict |
| Guest | Ownership, cookie expiry and rotation, cart-choice races, intent fencing, and single-target mailbox access |
| Telemetry | One trace per checkout with no personal data, every business counter incremented, and the [contract](OBSERVABILITY.md) table checked against the real exporter |

## Where the tests are

| Area | Location |
|---|---|
| Unit tests | Next to the code in each package |
| Integration tests (`-tags=integration`) | `backend/internal/platform/integration/` |
| Deployment helper (`-tags=deploycheck`) | `backend/internal/deploycheck`: creates the stranded order that `deploy-verify` recovers |
| Opt-in | Real SMTP (`ECOM_SMTP_SMOKE=1`) and database TLS (`ECOM_DB_TLS=1`) |

The latest results, with counts and tool versions, are recorded in [../RELEASE.md](../RELEASE.md).
