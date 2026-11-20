# Backend architecture

## Shape

One Go module, one API process, and one PostgreSQL 16 database. The same image also carries the command-line jobs that operators and the deployment run.

| Binary | Job |
|---|---|
| `api` | HTTP API, plus the built SPA when `STATIC_DIR` is set |
| `migrate` | Forward-only schema migrations, with the SQL embedded in the binary; holds an advisory lock |
| `db-bootstrap` | Creates the database roles and their grants on RDS; idempotent |
| `reconcile` | Operator recovery of interrupted checkouts (dry-run by default) |
| `maintain` | Batch cleanup of expired guest data |

| Package | Responsibility |
|---|---|
| `internal/auth` | Passwords, JWT, refresh sessions, Origin/CSRF middleware, rate limiters, account security flows |
| `internal/commerce` | Profile, addresses, catalog, admin products and inventory, carts (account and guest) |
| `internal/checkout` | Reservation (T1), processing claim, payment simulator, settlement (T2), cancellation, orders, recovery, guest checkout |
| `internal/db` | Handwritten SQL and the type-safe pgx code that `sqlc` generates from it |
| `internal/platform/*` | Config validation, database pool, SMTP, HTTP server and middleware, client IP, telemetry, business metrics |

Services own their `pgx.Tx` directly; there is no repository-per-table layer. Transactions are the core of the design, so they stay visible in the service code instead of being hidden behind an abstraction.

## Why so little infrastructure

| Choice | Why | Trade-off accepted |
|---|---|---|
| No queue, Redis, background worker or payment provider | Correctness comes from PostgreSQL constraints and short transactions, which can be tested directly. Each extra moving part would add a failure mode without changing that | Checkout is synchronous, and recovery is an explicit operator or scheduled job. Asynchronous payments are deliberately left to a later project |
| Rate-limit counters in PostgreSQL when several tasks run (`RATE_LIMIT_STORE=postgres`), in memory otherwise | Limits hold across API tasks with no new service | One write per limited request; the limits fail closed while the database is down |
| `sqlc` instead of an ORM | The SQL is reviewed as SQL; the lock order and the columns each statement touches are explicit | More boilerplate for simple CRUD |
| Our own HTTP and pgx instrumentation instead of `otelhttp` and `otelpgx` | Span names must use the route pattern (known only after routing), and query arguments must never be recorded; both are enforced and tested in about a hundred lines | Code we maintain ourselves |
| Distroless static runtime image, non-root user, no shell | Small attack surface; pgx and Argon2id are pure Go, so the binaries are static | No in-container health check or shell; probes run from outside the container and debugging uses `docker debug` |

## Request handling

- **Strict JSON:** unknown, duplicate or `null` fields are rejected, and bodies over 64 KiB return 413. PATCH treats an omitted field as unchanged, rejects `null`, and treats an empty string as clearing optional text.
- **Every request** loads the current session and role from the database, so logout, deactivation and role changes take effect immediately. The role claim inside the JWT is not trusted.
- **Errors** use one envelope, `{code, message}`. Stack traces and SQL errors never reach the client.
- **Logs** are JSON, with request ID, route, status, duration and trace ID. They never contain bodies, passwords, addresses or URLs that carry secrets. A client that disconnects is logged as 499, separately from the status the handler wrote, so disconnects never look like server errors.
- **Static SPA (optional):** API routes are matched first, then files, then `index.html`, which is served only for extension-less `GET`/`HEAD` requests. Hashed assets are `immutable`, and `index.html` is `no-cache`. The directory is opened with `os.Root`, so `..` and symbolic links can't escape it.

## Runtime limits

These are set in code, so a misconfigured environment can't remove them.

| Setting | Value |
|---|---|
| pgx pool | max 10, min 0 (override with `pool_max_conns` / `pool_min_conns` in `DATABASE_URL`); connect timeout 5 s |
| PostgreSQL session | `statement_timeout` 5 s, `lock_timeout` 2 s; the `ecom_app` role also has an idle-in-transaction timeout of 30 s |
| Request work | 5 s context; checkout and guest flows have their own budgets (up to 40 s for one combined action) |
| HTTP server | read-header 5 s, read 10 s, write 15 s, idle 60 s; graceful shutdown 10 s |
| Argon2id | 2 concurrent hashes per process; extra work gets 429 instead of exhausting memory |

## Health

| Route | Returns 200 when | Used by |
|---|---|---|
| `/health/live` | The process can respond | ALB target health on AWS |
| `/health/ready` | PostgreSQL answers, and the applied schema is **at least** the build's minimum (16) | Deployment checks after migration |

The ALB probes `/health/live`, not readiness. With readiness, a database outage marked every task unhealthy, and ECS replaced them all in a loop. With liveness, tasks stay registered, answer errors during the outage, and recover by themselves when the pool reconnects. This was verified on AWS by stopping RDS for 9 minutes: no task was replaced.

Readiness accepts a newer schema than the build needs, so an expand migration can run while the previous release is still serving.

## Configuration modes

| Mode | Enforced at startup |
|---|---|
| `local` | Loopback listener only; the database may skip TLS only on loopback; TLS optional |
| `production` | HTTPS origin, `sslmode=verify-full` to the database, TLS on the listener, SMTP mail, `Secure` cookies and HSTS |

Invalid or half-set configuration fails at startup instead of falling back to something weaker. Examples: only one of the TLS certificate and key set, an OTLP protocol the build can't speak, or a metrics port equal to the API port.
