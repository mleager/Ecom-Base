# Key decisions

The decisions that shape the whole project. Each area has its own, more detailed table: [api](api/README.md), [backend](backend/README.md), [frontend](frontend/README.md), [terraform](terraform/DESIGN.md).

## Architecture

| Choice | Why | Trade-off accepted |
|---|---|---|
| **One Go API and one PostgreSQL database.** No queue, cache, worker, reverse proxy or payment provider | The project is about invariants enforced in SQL transactions; extra infrastructure would hide them | Nothing runs asynchronously, so recovery is a scheduled job rather than an event consumer |
| **One container image** holds `api`, `migrate`, `db-bootstrap`, `reconcile`, `maintain` and the built SPA | One digest identifies code, schema and frontend together; the same image runs under Compose, ECS or Kubernetes | Every change, even frontend-only, produces a new image |
| **The API serves the SPA from the same origin** on a single host; on AWS, CloudFront joins S3 and the API under one origin | One cookie site, no CORS in production, email links land on the right server | The single-host and CDN paths each need their own cache and header rules |
| **The Go process terminates TLS itself**, even behind the ALB | The "TLS required in production" rule never needs a "TLS ends upstream" exception | Certificates to issue and renew for every hop |
| **Telemetry is built in; the observability stack is not** | Later portfolio projects diagnose incidents from this telemetry and can't add it after release | The binary grows from about 4 MB to 13 MB (OpenTelemetry and Prometheus libraries) |

## Correctness

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Reserve (T1) and settle (T2) are separate transactions**, with a committed claim in between and the payment outside any transaction | No locks held during payment work; every crash point leaves a state that recovery can finish | Orders can sit in `pending` and need a recovery path ([backend/CHECKOUT.md](backend/CHECKOUT.md)) |
| **Idempotency keys map to one order forever**, checked against a SHA-256 of the original intent before the cart is read | A retry stays valid after checkout has emptied the cart; a reused key with a different body is rejected | Clients must keep the original key and body until they see an outcome |
| **A lost COMMIT reply is "unknown", not "failed"**: the API looks the key up on a fresh connection and returns 503 if it still can't tell | Absence of evidence is not proof of rollback | The client sees a 503 it must retry, rather than a clean error |
| **Recovery is an explicit, idempotent command** (`reconcile`, dry run by default), scheduled every 5 minutes on AWS | No hidden background worker; every action is logged and can be replayed | Up to about 20 minutes before a stranded order settles |
| **Money is `BIGINT` cents**, capped at 10¹² | No floating point; stays inside JavaScript's exact-integer range | USD only |
| **Retire, never delete**, products and users | Order history stays intact | Retired rows stay in the database |
| **Migrations are forward-only and expand-then-contract**; readiness accepts a *minimum* schema version | A rolling deploy runs the old and new release against one schema; rolling schema back can destroy data | A removal takes two releases |

## Security

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Separate database roles**: a migrator that owns the schema, and a runtime role with column-scoped grants | An application bug can't change the schema or write columns it never needs | Every new column needs a grant |
| **Short JWT in memory plus a rotating refresh cookie**; the session is checked in the database on every request | Logout, deactivation and role changes take effect at once; no token in browser storage | One database read per authenticated request |
| **Reusing a rotated refresh token revokes the session**, after a 30-second grace | Detects a stolen token without signing out two tabs that refresh together | A replay inside the grace window isn't caught |
| **Rate limits shared in PostgreSQL** behind several tasks; keys stored as SHA-256 digests; the store fails closed | Limits hold per viewer across tasks, with no Redis; the table holds no personal data | One write per limited request; a database outage also refuses limited requests |
| **Client IP from one trusted header** (`CloudFront-Viewer-Address`) only when configured; IPv6 keyed on its /64 | Forged forwarding headers have no effect; one IPv6 host can't rotate addresses past a limit | Shared IPv4 (carrier NAT) can trip limits for unrelated users |
| **Email tokens in the URL fragment**, removed before routing and kept in memory | Tokens never reach server logs, `Referer` headers or browser storage | The SPA must strip the fragment before anything else reads the URL |
| **Guest data stays on the server**; the browser keeps an opaque reference | No personal data in `localStorage` | Guest sessions expire (7 idle days, 30 at most) |

## Delivery

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Distroless, non-root runtime image**, every base pinned by digest | No shell or package manager to exploit; tests run on the exact bases that ship | No in-container health check; debugging needs `docker debug` or an ephemeral container |
| **Migrations run as a one-off job before the API**, never at API start-up | Only the job holds migrator credentials; a failed migration stops the rollout | One more step in every deployment |
| **New dependencies only after two weeks**, exact pins, `govulncheck` in `check` | Avoids freshly published and compromised releases; reachable vulnerabilities fail the build | Fixes arrive up to two weeks late |
| **Release evidence comes from a script** that builds from `git archive HEAD` | Ignored or uncommitted files can't reach the image or the record | Builds aren't bit-for-bit reproducible, so consumers pin the recorded digest |
| **Plain HTTP remains the default developer loop**; HTTPS and the packaged deployment are extra run modes with their own tests | Fast daily feedback, and 348 browser tests that didn't churn | Three run modes to keep working |

## Observability

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Standard `OTEL_*` settings only**; traces over OTLP/HTTP; metrics pulled in Prometheus format from a separate listener | Any Collector or vendor works unchanged; the metrics port is never routed by a CDN or load balancer | Two delivery paths (push for traces, pull for metrics) |
| **Own HTTP and database instrumentation** instead of `otelhttp`/`otelpgx` | Labels use the route pattern and query name, never raw paths or arguments; the data rules are enforced in tested code | Instrumentation code of our own to maintain |
| **The metric list is a versioned, tested contract** ([backend/OBSERVABILITY.md](backend/OBSERVABILITY.md)) | Alerts and dashboards in later projects depend on exact names; a test fails on any drift | Renames are breaking changes that raise the contract version |
| **Only abuse limiters are counted as rejections.** The password-hashing slots, the per-account security-mail limit and the guest write slot aren't | Those are concurrency or per-account policies with different status codes | They can be added later without renaming anything |

## Scope

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Simulated payment** with an explicit *accept* or *reject* choice | Shows both settlement and stock release, deterministically | No provider integration or webhooks |
| **Sign-in never merges carts**; the shopper picks one | No silent changes to someone's cart | One extra decision for the shopper |
| **Literal substring search, Previous/Next pagination, no counts** | Enough for the catalog, with no search service or count queries | No ranking, facets or page numbers |
| **Registration reveals an existing email** (`409`), password reset doesn't | Clear sign-up feedback; per-email and per-IP limits slow enumeration | Account existence can be probed slowly |
