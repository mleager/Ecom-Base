# Commerce Reliability Lab — Project 1

Milestones 1–17 are complete. Release **v1.0.0** (local annotated tag,
2026-11-09) is one application image with the API, the migration job, the
order-recovery CLI and the same-origin React app, verified in a production-mode
Compose deployment. Release **v1.1.0** (2026-11-18) runs the same image on AWS:
the app on S3 and CloudFront, several API tasks behind a load balancer with
shared rate limits, and a Terraform development stack
([infrastructure/terraform](infrastructure/terraform/README.md)). Evidence and
known limits:
[RELEASE.md](docs/updated/RELEASE.md) · [Status](docs/updated/STATUS.md) ·
[Documentation index](docs/updated/README.md).

**To set up, run, test or deploy the project, follow [HOW_TO.md](HOW_TO.md).**
It lists every command in the order you need them: first-time setup over HTTP
and HTTPS, demo data (fixtures), testing, the release image, and operations.

For development, Go runs locally and Docker Compose runs PostgreSQL only.
`compose.yaml` and the ignored `.env` live in the repository root, and the
PostgreSQL bootstrap script `infrastructure/postgres/init.sh` is mounted into the
container by Compose. The release image runs through its own deployment profile,
`compose.deploy.yaml` ([HOW_TO.md](HOW_TO.md#7-the-release-image)).

Implemented: five initial schema migrations, four permission migrations and credential-version
migrations 10–11 (credential versioning, verification and token/pending-email storage), 
generated pgx queries, validated configuration, a bounded connection pool, 
structured request logs, graceful shutdown, root health checks, customer registration, 
login, rotating refresh/logout sessions, authenticated account reads/updates, 
saved-address CRUD, public catalog browsing, administrator product and stock management, 
persistent carts, administrator authorization for metrics, complete T1 checkout, processing claims, 
deterministic simulated payments, atomic settlement/cancellation, customer order/payment APIs, 
and an explicit recovery command with read-only diagnostics.

Current completion and remaining project work are in
[PROJECT_STATUS.md](docs/PROJECT_STATUS.md). Checkout and order HTTP routes are
enabled. Operator recovery is documented in [RECOVERY.md](docs/backend/RECOVERY.md).

Documentation starts at the [documentation map](docs/README.md). Detailed
[backend documentation](docs/backend/README.md) and
[frontend](docs/frontend/OVERVIEW.md) have separate directories. Project-wide
scope, milestone ordering and status remain in the top-level `docs/` summaries.
For the initialized Vite/React/TypeScript workspace and local commands, see the
[frontend README](frontend/README.md).

For the complete setup, configuration, migration-status, administrator provisioning,
health and troubleshooting procedure, use the [operator guide](docs/backend/OPERATIONS.md).

## Database roles and migrations

The database initialization script creates a migration owner and a restricted
runtime login. Initialization runs only on the volume's first boot: editing
passwords in `.env` does not rotate existing PostgreSQL passwords. Keep that file
private, use explicit operator SQL for rotation, and never reset volumes as a
password-change shortcut.

Migration 6 adds only the column writes authentication needs: create a customer
and cart, insert/rotate/revoke sessions, and upgrade password hashes. Runtime SQL
cannot set user roles/activation flags, create tables, or edit migration status.
Migration 7 adds profile/address/catalog/on-hand inventory/cart write permissions.
Migration 8 adds T1 record insertion and reservation-counter writes. Migration 9
adds only the state/timestamp/failure-code writes for settlement and cancellation.
Runtime SQL cannot reassign ownership, change user roles/activation, physically
delete products, rewrite order/item snapshots, or change payment scenarios and
attempt identities. The API enforces resource ownership and administrator policy.
The API never runs migrations; apply them as a separate step
([HOW_TO.md](HOW_TO.md#5-everyday-development)).

## Authentication API

| Method and path | Behavior |
|---|---|
| `POST /api/v1/auth/register` | Create a customer and its persistent cart atomically; return the user |
| `POST /api/v1/auth/login` | Verify credentials; return a 15-minute access JWT and set a refresh cookie |
| `POST /api/v1/auth/refresh` | Rotate the current refresh verifier; retain the original seven-day expiry |
| `POST /api/v1/auth/logout` | Revoke the cookie's session and clear it; no access JWT required |
| `GET /api/v1/users/me` | Return the current active user after bearer and database-session validation |
| `POST /api/v1/users/me/password` | Verify current password, replace it atomically and revoke all sessions; explicit login required |
| `GET /metrics` | Require the current database role to be admin; expose an authentication request counter |

Passwords are preserved exactly and must contain 15–128 Unicode code points
(at most 512 UTF-8 bytes). Stored passwords use Argon2id at 64 MiB/3 iterations.
Registration never accepts a role. The same trimmed/lowercase email cannot be
registered twice. Registration does not automatically create a login session.

Login, refresh, logout and password changes require both `Origin: http://localhost:5173` and
`X-CSRF-Protection: 1` in the default local configuration. Set `FRONTEND_ORIGIN`
explicitly for a different frontend; production requires an HTTPS origin.
Registration/login JSON schemas are in `docs/api/openapi.yaml`. For authenticated
requests send `Authorization: Bearer <access_token>`. Keep access tokens in memory;
browser requests to refresh/logout must include credentials so the HttpOnly cookie
is sent. Local HTTP cookies omit Secure; production mode enables it.

Use `/account/security` in the frontend to change a password. Its credentialed
bearer request supplies `current_password` and `new_password`; current-password
failure is 403. Success signs out every session and clears the refresh cookie.
The browser sends this write once and hides private state after an uncertain
result; deliberate sign-in checks the outcome. Migration 10 adds only an internal
credential version. Migration 11 adds explicit email verification and security proofs.
Use Account security to request a verification email, then confirm the emailed link
with the requesting account/current password. Existing emails start unverified;
verification preserves sessions. Verified password changes send a best-effort notice
(`accepted`/`unconfirmed`); unverified addresses return `not_applicable`.
See [SMTP setup and token pruning](docs/backend/OPERATIONS.md#security-email-configuration-and-verification).
Account security also supports verified email changes: confirm both mailbox links
with the current password, then sign in with the new email. The first proof keeps
the old email; completion revokes every session and preserves account ownership.
Replacement/cancellation, duplicate conflicts and uncertain outcomes have explicit
status/recovery handling. Emailed password recovery remains M9 task 6.

Clients must serialize refresh calls: one concurrent use of the current cookie
wins, and stale tokens return 401 without clearing a newer cookie. Expiry is based
on PostgreSQL time and is never extended. Logout revokes that session immediately
for subsequent authorization checks, including its still-unexpired access JWTs.
Other sessions remain valid. Old refresh-token families are not tracked by the
approved schema. If a rotation commits but its response is lost, the old cookie
cannot recover the new secret; sign in again. Errors never claim automatic session
recovery. Login/register rate limits and the two-operation hashing limit may
return 429 with Retry-After.

No administrator is seeded. An authorized operator can promote an explicitly
selected registered user using a parameterized maintenance query, with that
user's UUID bound as `$1`:

```sql
UPDATE users SET role = 'admin', updated_at = now()
WHERE id = $1 AND role = 'customer' AND is_active
RETURNING id, email, role;
```

Use migration/operator credentials for that intentional action; the runtime role
cannot execute it. Customer endpoints cannot promote users or deactivate accounts.
The [administrator procedure](docs/backend/OPERATIONS.md#provision-an-administrator)
defines identity inspection, parameter binding, transaction review and verification.

## Account, catalog and cart APIs

For isolated demonstration/test data, create a fixture
([HOW_TO.md](HOW_TO.md#4-demo-data-fixtures)). The [fixture guide](docs/frontend/FIXTURES.md)
covers generated credentials, versioned images, API startup and owned cleanup;
ordinary development data is preserved.

All paths below start with `/api/v1`. Only public product browsing is anonymous;
other operations require a bearer access token. Administrator operations also
check the user's current database role.

| Method and path | Behavior |
|---|---|
| `PATCH /users/me` | Update supplied first/last names; preserve omitted fields |
| `GET /users/me/addresses` | List the caller's saved addresses |
| `POST /users/me/addresses` | Create a validated US shipping address |
| `PATCH /users/me/addresses/{id}` | Update an owned address |
| `DELETE /users/me/addresses/{id}` | Delete an owned saved address |
| `GET /products` | Browse or literal name/SKU search with optional `q`, `limit`/`offset`, ordered by name and ID |
| `GET /products/{id}` | Read an active product and current availability |
| `GET /admin/products` | List active/retired products with optional `is_active`, `limit`/`offset` |
| `GET /admin/products/{id}` | Read an active or retired product as current administrator |
| `GET /admin/products/{id}/inventory` | Read coherent on-hand/reserved/available counters without a stock write |
| `POST /admin/products` | Atomically create a product and its zero-stock inventory row |
| `PATCH /admin/products/{id}` | Update supplied product fields or reactivate a product |
| `DELETE /admin/products/{id}` | Retire a product without deleting its data |
| `PATCH /admin/products/{id}/inventory` | Apply a signed on-hand adjustment, preserving reservations |
| `GET /cart` | Read a coherent cart/version snapshot |
| `POST /cart/items` | Add quantity to a product's existing line or create a line |
| `PATCH /cart/items/{id}` | Replace the quantity of an owned item |
| `DELETE /cart/items/{id}` | Remove an owned item |
| `DELETE /cart/items` | Clear the cart, including an already empty cart |

Request/response schemas and status codes are in [OpenAPI](docs/api/openapi.yaml).
PATCH rejects null, unknown fields and empty objects. Optional text can be
cleared with an empty string; omitted fields retain their values. Duplicate SKUs
return 409. Cart quantities are 1–10,000 with at most 100 distinct products. All
successful cart changes increment the locked cart version once, even unchanged
quantity/empty-clear operations. Missing/foreign items return 404 without a change.
Adding/replacing quantities requires an active product; removing retired items
remains possible. Carts do not require available stock or reserve it; checkout
will perform the definitive stock and price checks.

## Checkout and order APIs

`checkout.Service.CreatePending(ctx, authenticatedUserID, key, request)` creates
the complete pending-order graph, inventory holds and cart consumption in one
transaction. The request contains `cart_version`, `shipping_address_id` and
`payment_scenario`; the caller supplies the authenticated actor separately.
The HTTP service then commits a processing claim, runs the local simulator
outside any transaction, and atomically settles every reservation in T2.

| Method and path (under `/api/v1`) | Behavior |
|---|---|
| `POST /checkout` | Require bearer authentication and one `Idempotency-Key`; create and process a checkout |
| `GET /orders` | List owned orders, newest first, with bounded `limit`/`offset` |
| `GET /orders/{id}` | Read an owned order with immutable snapshots and current payment status |
| `GET /orders/{id}/payments` | Read safe payment attempt fields for an owned order |
| `POST /orders/{id}/cancel` | No body; cancel only before processing is claimed, or return the already cancelled order |

`payment_scenario` is explicitly a Project 1 simulator input: `accept` confirms
the order and consumes stock; `reject` creates a `payment_failed` order and
releases holds. No real payment occurs. A newly settled order returns 201 for
either scenario. Identical retries return 200. A known committed pending order
after interruption returns 202. An unresolved COMMIT returns 503; retry the
identical key/body (or cancellation for the same order). Never create a new key
to resolve an uncertain checkout.

Identical user/key/intent retries return the retained order/current status even
after cart clearing or source edits/deletion. Changed intent conflicts. Stock is
reserved in UUID order, totals are computed from server prices with bounds, and
all inserts/cart changes roll back on failure. Lost COMMIT acknowledgement uses
a bounded lookup on an independent healthy connection and the same advisory
lock. An unresolved outcome returns the service's `checkout_outcome_uncertain`
error; callers must retry the identical key/body. The service never blindly
replays an uncertain transaction or processes payment on an existing-key retry.

GET and same-key retries only observe status. They never resume an interrupted
pending/processing attempt. Holds remain active until explicit settlement or
eligible cancellation; the 15-minute threshold does not release stock. The
operator recovery command now resumes eligible interrupted orders explicitly.
There is no automatic recovery runner.

See [T1 evidence](docs/backend/evidence/MILESTONE_2_CHECKOUT.md) and
[payment evidence](docs/backend/evidence/MILESTONE_3_PAYMENTS.md) for PostgreSQL contention,
rollback, HTTP, cancellation-race and connection-loss verification.

## Recover interrupted orders

The commands are in [HOW_TO.md](HOW_TO.md#recover-interrupted-orders). A dry run is
read-only; `--apply` explicitly applies recovery. Both use the runtime database
credentials; no JWT secret is needed by the command itself.

Recovery considers pending orders at least 15 minutes old, claims pending
attempts or re-derives processing outcomes, and reuses exactly-once settlement.
Concurrent operators skip locked candidates; corrupt state is reported without
automatic repair. JSON Lines include action events and a bounded diagnostic
summary; inconsistent, failed or unresolved runs exit nonzero. See
[operator instructions](docs/backend/RECOVERY.md) for limits, cutoff behavior and safe reruns.
