# Backend

A Go API backed by one PostgreSQL database. The interesting part is not the endpoints; it is how checkout stays correct when requests race, replies get lost and processes crash mid-payment.

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Packages, request handling, runtime limits, and why there is no queue, cache or worker |
| [CHECKOUT.md](CHECKOUT.md) | The two-transaction checkout, idempotency, lost COMMIT replies, recovery, and guest checkout |
| [DATABASE.md](DATABASE.md) | Schema, least-privilege roles, invariants, lock order, migrations |
| [SECURITY.md](SECURITY.md) | Passwords, sessions, CSRF, rate limits, email-based account recovery |
| [OBSERVABILITY.md](OBSERVABILITY.md) | The tested telemetry contract: every span, metric, label and log field |
| [OPERATIONS.md](OPERATIONS.md) | Runbook: configuration, migrations, recovery CLI, maintenance, troubleshooting |
| [TESTING.md](TESTING.md) | What is tested against real PostgreSQL, and the fault-injection experiments |

The HTTP contract is [../api/openapi.yaml](../api/openapi.yaml). Decisions that span the whole project are in [../DECISIONS.md](../DECISIONS.md).
