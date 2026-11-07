# Overview

**Commerce Reliability Lab, Project 1.** A small, complete online store built to show correct transactional behavior under failure: no overselling, exactly-once settlement, safe retries and explicit recovery. It is also the healthy baseline that Projects 2–6 will fork to introduce controlled faults.

## What it does

- **Customers:** register, sign in, edit profile, manage US shipping addresses, change password and email, reset a forgotten password.
- **Shoppers (signed in or guest):** browse and search the catalog, use a persistent cart, check out with a simulated payment, view orders and cancel eligible ones.
- **Guests:** shop and buy without an account. They can recover access to one order or checkout through a mailbox link.
- **Administrators:** search, create, edit, retire and reactivate products, and adjust stock.
- **Operators:** provision admins with SQL and recover interrupted orders with a CLI.

Payment is a deterministic **simulation**. The shopper explicitly picks `accept` or `reject`. There is no card form and no payment provider.

## Architecture

```text
Browser (React SPA, Vite dev server :5173)
   │  JSON over HTTP, CORS with exact origin
   ▼
Go API (chi, :8080, loopback)  ──►  PostgreSQL 16 (Docker, loopback)
   │                                   ▲
   └─ SMTP (optional, STARTTLS/TLS)    │
                                       │
Operator CLIs: reconcile, fixtures ────┘
```

| Layer | Technology |
|---|---|
| API | Go (module `ecom`), chi router, pgx pool, sqlc-generated queries |
| Schema | goose SQL migrations; separate migrator and runtime database roles |
| Auth | Argon2id passwords, HS256 JWT access tokens (memory only), rotating HttpOnly refresh cookie |
| Frontend | React 19, React Router 8 (declarative), Vite 8, TypeScript 7, Tailwind 4 + project-owned shadcn components |
| Tests | Go unit and PostgreSQL integration tests; Vitest; Playwright against real Go/PostgreSQL |

Go, goose and sqlc run on the host. Docker runs PostgreSQL only.

## Trust boundaries

- **The server is authoritative** for prices, stock, cart versions, ownership, roles and order state. Browser totals are estimates.
- **Every authenticated request** rechecks the database session and current role. JWT role claims are not trusted.
- **Runtime database role** has column-scoped grants only. It cannot change roles, run DDL, delete products or rewrite order history.
- **Browser storage** holds no credentials, addresses or cart contents. It holds only small checkout-recovery records (keys and IDs).
- **Operator actions** (admin promotion, recovery, data pruning) are deliberate CLI or SQL steps, never HTTP endpoints.

## Core guarantees

1. A checkout never reserves more stock than is available.
2. Each reservation is settled or released exactly once.
3. One idempotency key maps to one order, permanently.
4. Different keys for the same cart version produce at most one order.
5. A lost reply is treated as **unknown**, never as a rollback. The client retries with the same key and body.
6. Expiry alone never releases stock. Only explicit recovery or eligible cancellation does.

## Out of scope

Real payments, refunds, taxes, shipping rates, categories and facets, product reviews, image upload, MFA, social login, account deletion, a browser role editor, background workers, queues, Redis, a reverse proxy and multi-instance deployment. Durable asynchronous processing is reserved for Project 7.

## Release path

Milestone 14 makes the API serve the built SPA from one HTTPS origin, with database TLS ([MILESTONE_14.md](MILESTONE_14.md)). Milestone 15 packages it into an image, verifies Compose deployment, records release evidence and tags the baseline ([MILESTONE_15.md](MILESTONE_15.md)).
