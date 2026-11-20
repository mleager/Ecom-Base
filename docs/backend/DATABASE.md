# Database

PostgreSQL 16: 16 forward migrations and 22 tables. The migrations in [`backend/migrations`](../../backend/migrations) are the source of truth.

## Design choices

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Invariants live in constraints**, not only in Go: `quantity_on_hand >= quantity_reserved >= 0`, one order per cart version, at most one live payment attempt per order, exactly one owner per cart and order | A bug in application code can't commit an impossible state | Some failures surface as constraint violations that the code must map to the right error |
| **Separate roles.** `ecom_migrator` owns the schema; `ecom_app` (the API) has `SELECT`/`INSERT` plus **column-scoped** `UPDATE` only | An application bug or SQL injection can't run DDL, `DELETE`, change roles, rewrite order snapshots or edit migration history | Every new column needs an explicit grant in a migration |
| **Short `READ COMMITTED` transactions with explicit row locks** in a fixed order; deadlocks and serialization failures are retried up to 3 times | Predictable locking without the retry storms of `SERIALIZABLE` | The lock order must be followed by hand |
| **Money as `BIGINT` cents** (USD, capped at 10¹²) | No floating point; stays below JavaScript's exact-integer limit | Single currency |
| **Soft lifecycle:** products are retired and users deactivated; order history is never deleted (`RESTRICT` foreign keys) | Orders always point to real rows | The tables only grow; cleanup is limited to expired tokens and guests |
| **Secrets stored only as SHA-256 digests** (refresh tokens, security tokens, guest sessions, recovery proofs, rate-limit keys) | A database leak doesn't hand out live credentials | Tokens can't be shown again, only replaced |
| **Rate-limit counters in an `UNLOGGED` table**, keyed by digest | No WAL write per request; the table holds no personal data | A crash empties it, which only restarts the current windows |
| **Forward-only migrations, expand then contract** | Migrations run before a rollout, while the previous release is still serving, and a failed deploy rolls back code, not schema | Removing a column takes two releases |

## Roles and bootstrap

| Role | Used by | Can |
|---|---|---|
| `postgres` / RDS master | Bootstrap only | Everything; on RDS its password is managed by AWS and readable only by the bootstrap job |
| `ecom_migrator` | `migrate`, `maintain`, operator SQL | Owns the schema |
| `ecom_app` | `api`, `reconcile` | Column-scoped DML, no `DELETE` |

`db-bootstrap` (Go, in the image) creates the roles on RDS and is idempotent. It sends role passwords as **SCRAM-SHA-256 verifiers computed in Go**, never as plain text. PostgreSQL logs the text of a failing statement, and on RDS that log is readable by anyone with log access. The `ecom_app` role also gets default timeouts (statement 5 s, lock 2 s, idle-in-transaction 30 s), which bound any session, not only the API's pool. In the deployment, the server accepts only TLS with SCRAM for the two application roles; the superuser can't connect over the network.

## Lock order

| Flow | Order |
|---|---|
| Cart write | cart row, then a shared lock on the product |
| T1 (account) | advisory key lock → cart → inventory by product UUID |
| T1 (guest) | guest → scoped grant → owner/key → intent → cart → inventory by product UUID |
| Claim, T2, cancel, recovery | order → payment attempt → reservations → inventory, each by product UUID |
| Account security | user → pending email change → security tokens → sessions |

## Migrations

| # | Adds |
|---|---|
| 1–5 | Identity, catalog and inventory, carts, orders and reservations, payments, idempotency, history |
| 6–9 | Column-scoped grants for auth, the core API, checkout and settlement |
| 10–11 | Credential version; email verification and change; security tokens |
| 12–13 | Guest principals, sessions, carts, cart choice, checkout intents, recovery proofs and grants; single-owner carts and orders |
| 14 | `rate_limit_buckets` (shared rate limits across API tasks) |
| 15 | Guest idle expiry |
| 16 | Refresh-token reuse detection |

`migrate up` runs each migration in its own transaction, under a session advisory lock, with a 10-second `lock_timeout`. A migration stuck behind a long transaction therefore fails and rolls back instead of blocking traffic. A failure keeps the earlier migrations and is fixed with a new forward migration. Down migrations exist only for disposable test databases, and the guest ones refuse to run if data would be lost.

## Indexes

Indexes are added only when a query needs them: recent orders per customer, a partial index on pending orders by deadline (used by recovery), active reservations per product, active products by name, and sessions per user by expiry.

## Known limits

- One database instance; there is no read replica or connection pooler. Pool size is set per API process and must fit within `max_connections` across all tasks.
- Backup and restore are not part of this project. The AWS stack keeps 1 day of RDS automated backups; restore drills belong to the database-recovery scenario project.
