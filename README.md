# Commerce Reliability Lab: Project 1

An online store built to stay correct when things fail: no overselling, exactly-once payment settlement, safe client retries, and explicit recovery when a process dies mid-checkout. It ships as one container image and runs on a single host or on AWS behind CloudFront and a load balancer.

It is the baseline for a DevOps portfolio. Later projects run this exact image to stage incidents (bad deploys, database outages, connection exhaustion) and diagnose them with the telemetry built in here.

**Release 1.0.0:** tag `base-v1.0.0`, image `ghcr.io/mleager/ecom-base:1.0.0` ([contents and evidence](docs/RELEASE.md)).

## What it shows

| Area | In this project |
|---|---|
| **Correctness under failure** | Two-transaction checkout with idempotency keys; a lost COMMIT reply is treated as unknown, not failed; a scheduled, idempotent recovery job finishes stranded orders ([checkout design](docs/backend/CHECKOUT.md)) |
| **Infrastructure as code** | Terraform for CloudFront, S3, a VPC origin, an internal ALB, ECS on EC2, RDS, Secrets Manager and EventBridge; one `apply`, proven with forced failures on AWS, then destroyed ([AWS design](docs/terraform/DESIGN.md), [cost](docs/terraform/COST.md)) |
| **Release engineering** | One distroless, non-root image pinned by digest; migrations as a separate job, expand-then-contract; scripted release evidence ([decisions](docs/DECISIONS.md#delivery)) |
| **Observability** | OpenTelemetry traces, Prometheus metrics and trace-linked logs, with a versioned, tested metric contract ([observability](docs/backend/OBSERVABILITY.md)) |
| **Security** | Least-privilege database roles, rotating refresh tokens with reuse detection, rate limits shared across tasks, TLS to the API, database and mail server ([security](docs/backend/SECURITY.md)) |
| **Testing** | Go integration tests on real PostgreSQL with fault injection, 1,374 frontend unit tests, 348 browser tests against a real API, deployment verification ([backend](docs/backend/TESTING.md), [frontend](docs/frontend/TESTING.md)) |

## Stack

Go (chi, pgx, sqlc) · PostgreSQL 16 · React 19, TypeScript, Vite, Tailwind · Docker and Compose · Terraform on AWS · OpenTelemetry · Playwright

## Where to go next

- **Design and trade-offs:** [docs/](docs/README.md), starting with [DECISIONS.md](docs/DECISIONS.md).
- **Run it:** [HOW_TO.md](HOW_TO.md) has every command, from first setup to the AWS stack.
- **How it was built:** [HISTORY.md](docs/HISTORY.md), seventeen milestones.
