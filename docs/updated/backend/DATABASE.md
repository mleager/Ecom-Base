# Database

PostgreSQL 16. The migrations in [`backend/migrations`](../../../backend/migrations) are the authority. Version 13 has 21 tables plus goose metadata. The original [DATABASE_SCHEMA.md](../../backend/DATABASE_SCHEMA.md) contains reference DDL for the account baseline.

## Migrations

| # | File | Adds |
|---|---|---|
| 1 | `00001_identity` | `users`, `user_sessions`, `addresses` |
| 2 | `00002_catalog_inventory` | `products`, `inventory` |
| 3 | `00003_cart` | `carts`, `cart_items` |
| 4 | `00004_orders_reservations` | `orders`, `order_items`, `inventory_reservations` |
| 5 | `00005_payment_idempotency_history` | `checkout_idempotency`, `payment_attempts`, `order_status_history` |
| 6–9 | `*_permissions` | Column-scoped runtime grants for auth, core API, checkout (T1) and settlement |
| 10 | `00010_credential_version` | `users.credential_version` |
| 11 | `00011_email_verification` | `users.email_verified_at`, `email_change_requests`, `account_security_tokens` |
| 12 | `00012_guest_carts` | `guest_principals`, `guest_sessions`, `guest_cart_choices`, `guest_checkout_intents`; carts get one owner (`user_id` or `guest_id`) |
| 13 | `00013_guest_checkout` | `guest_recovery_tokens`, `guest_recovery_sessions`; orders and idempotency get one owner; guest orders link to their intent |

## Roles

| Role | Used by | Can |
|---|---|---|
| `postgres` | Bootstrap and integration tests only | Everything |
| `ecom_migrator` | goose, fixture creation, operator SQL | Owns the schema; runs migrations, admin promotion and pruning |
| `ecom_app` | API and recovery CLI | `SELECT`/`INSERT` plus column-scoped `UPDATE` only |

The runtime role **cannot** change user roles or active flags, reassign ownership, run DDL, `DELETE` or `TRUNCATE`, hard-delete products, rewrite order and item snapshots, change payment scenarios or attempt identities, change reservation links or deadlines, rewrite idempotency or history rows, or touch goose metadata.

Bootstrap (`infrastructure/postgres/init.sh` locally, `db-bootstrap` on AWS) runs only when the volume is first created, or, for `db-bootstrap`, when Terraform reruns it.

- **Passwords never reach the server log.** PostgreSQL logs the text of a failing statement (`log_min_error_statement = error`), and on RDS that log is kept and readable by anyone with log access. `db-bootstrap` therefore sends only a SCRAM-SHA-256 verifier it computes itself (4096 iterations, random 16-byte salt), so role passwords must be printable ASCII (SASLprep leaves those unchanged). `init.sh` runs as the local superuser and turns statement logging off for its own session instead.
- **Role defaults for `ecom_app`:** `statement_timeout` 5000, `lock_timeout` 2000 and `idle_in_transaction_session_timeout` 30000 (ms). The API pool sets the first two on every connection anyway (`database.StatementTimeout`, `database.LockTimeout`); the role defaults bound any other session, such as `psql`, and end a transaction left idle while holding locks.
- **Volumes created before 1.1.1** lack the role defaults. Add them once as `postgres`:

  ```bash
  docker compose exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U "$POSTGRES_USER" -d ecom -c "ALTER ROLE ecom_app SET statement_timeout = 5000; ALTER ROLE ecom_app SET lock_timeout = 2000; ALTER ROLE ecom_app SET idle_in_transaction_session_timeout = 30000"'
  ```

## Conventions

- UUIDv4 primary keys generated in Go. `TIMESTAMPTZ` in UTC. Go sets `updated_at` explicitly.
- Money: non-negative `BIGINT` cents, USD. Go checks the upper bounds and overflow.
- Email is trimmed and lowercased before storage; a constraint enforces the canonical form.
- Soft lifecycle: products are retired (`is_active`) and users deactivated. Order history is never deleted.
- Secrets are stored only as SHA-256 digests: refresh tokens, security tokens, guest sessions and recovery proofs.

## Invariants

Enforced by constraints:

- `quantity_on_hand >= quantity_reserved >= 0`.
- Unique: `users.email`, `products.sku`, `(cart, product)`, `(order, product)`, `(owner, idempotency_key)`, `(order, attempt number)`.
- `orders(source_cart_id, source_cart_version)` is unique, so a cart version can be checked out only once.
- At most one `pending` or `processing` payment attempt per order (partial unique index).
- Carts, orders and idempotency rows have exactly one owner (`num_nonnulls(user_id, guest_id) = 1`).

Enforced by transactions and tests:

1. A checkout creates, in one transaction, one order, ≥1 item, one active reservation per item, one payment attempt, one idempotency row and one history row.
2. Each reservation matches its order item's product and quantity, and expires at order creation + 15 minutes.
3. Active reservations add up to `inventory.quantity_reserved`. Consuming a reservation lowers on-hand and reserved; releasing lowers reserved only.
4. `subtotal_cents` equals the sum of line totals.
5. Shipping snapshots are immutable after creation.
6. Status changes use conditional updates. A matching terminal result is a no-op only after the whole graph is validated.
7. Each owner has one persistent cart. Checkout clears its items and increments its version.

## Lock order

Always acquire locks in this order to prevent deadlocks.

| Flow | Order |
|---|---|
| Cart write | parent cart row first (shared for reads, exclusive for writes), then a shared lock on the product |
| T1 (account) | advisory key lock → cart → inventory rows by product UUID |
| T1 (guest) | guest principal → scoped grant (if used) → owner/key → intent → cart → inventory by product UUID |
| Claim, T2, cancellation, recovery | order → payment attempt → reservations by product UUID → inventory by product UUID |
| Account security | user → pending email request → security tokens → sessions (UUID order within each type) |

Writes use short `READ COMMITTED` transactions. Deadlocks (`40P01`) and serialization failures (`40001`) are retried up to 3 attempts in total, with the same identities. Recovery diagnostics use `REPEATABLE READ READ ONLY`.

## Deletion policy

- Product → inventory, cart items, order items, reservations: `RESTRICT`. Retire instead.
- User → orders, addresses, idempotency keys: `RESTRICT`. Sessions and cart: `CASCADE`, but referenced orders still block deletion.
- Order → items, payments, history, idempotency key: `RESTRICT`.

## Key indexes

`orders_customer_recent (user_id, created_at DESC)`, partial `orders_pending_expiry (reservation_expires_at) WHERE status = 'pending_payment'`, `reservations_by_status_expiry`, partial `reservations_product_active`, `products_active_name`, `sessions_user_expiry`, `addresses_user`. Add new indexes only when a query shows the need.

## Query files

| File | Covers |
|---|---|
| `auth.sql`, `accounts.sql`, `security.sql` | Users, sessions, profiles, addresses, security tokens |
| `products.sql`, `catalog.sql`, `cart.sql` | Catalog, admin products and inventory, carts |
| `checkout.sql`, `settlement.sql`, `recovery.sql` | T1, claim, T2, cancellation, recovery candidates and diagnostics |
| `guest.sql`, `guest_checkout.sql` | Guest sessions, carts, choices, intents, recovery |

Run `bash scripts/dev.sh generate` after editing SQL. `check` fails if the generated code is out of date.

## Data maintenance

Pruning is an operator task run as `ecom_migrator`, never by the API. Delete expired security and guest proof, session and grant rows at least 7 days after expiry, in separate committed batches of at most 500 rows. See [OPERATIONS.md](OPERATIONS.md#pruning).

Down migrations exist for testing in disposable databases. Never run them against data you want to keep. The guest migrations refuse to roll back when guest data would be lost.
