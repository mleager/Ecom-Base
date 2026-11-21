# Commerce Reliability Lab: Project 1 documentation

A small but complete online store, built to show **correct behaviour under failure**: no overselling, exactly-once payment settlement, safe retries, and explicit recovery when a process dies mid-checkout. It ships as one container image, and runs either on a single host (Docker Compose) or on AWS behind CloudFront with several API tasks.

It is also the baseline for the rest of the portfolio. Later projects run its released image to stage controlled incidents (bad deploys, database outages, connection exhaustion) and diagnose them with the telemetry built in here, without changing its code.

## Start here

| If you want… | Read |
|---|---|
| The design decisions and their trade-offs, in one place | [DECISIONS.md](DECISIONS.md) |
| How checkout stays correct under races, lost replies and crashes | [backend/CHECKOUT.md](backend/CHECKOUT.md) |
| The AWS architecture, and what broke when it was run for real | [terraform/DESIGN.md](terraform/DESIGN.md) |
| What is in release 1.0.0, and the evidence | [RELEASE.md](RELEASE.md) |
| How the project was built, milestone by milestone | [HISTORY.md](HISTORY.md) |
| To run it | [HOW_TO.md](../HOW_TO.md) |

| Area | Index |
|---|---|
| HTTP contract | [api/](api/README.md) |
| Go API, database, security, observability, operations | [backend/](backend/README.md) |
| React SPA, checkout recovery in the browser, UI, browser tests | [frontend/](frontend/README.md) |
| AWS development stack | [terraform/](terraform/README.md) |

## System at a glance

```text
                ┌──────────────── single host (Compose) ─────────────────┐
Browser ─HTTPS─▶│ api (Go, serves SPA + /api/v1) ─TLS─▶ PostgreSQL 16     │
                │ migrate (one-shot, before api)     Mailpit (SMTP TLS)   │
                └─────────────────────────────────────────────────────────┘

                ┌───────────────────────── AWS ───────────────────────────┐
Browser ─HTTPS─▶│ CloudFront ─▶ S3 (SPA)                                  │
                │      └─/api/*─▶ VPC origin ─▶ internal ALB ─▶ 2 ECS tasks ─▶ RDS
                │ EventBridge ─5 min─▶ reconcile + maintain ─fail─▶ SNS   │
                └─────────────────────────────────────────────────────────┘
```

| Layer | Technology |
|---|---|
| API | Go, chi, pgx, `sqlc`; Argon2id, JWT and rotating refresh cookies; OpenTelemetry |
| Data | PostgreSQL 16; goose migrations; separate migrator and least-privilege runtime roles |
| Frontend | React 19, TypeScript, Vite, Tailwind 4 with project-owned shadcn components |
| Packaging | One distroless, non-root image: `api`, `migrate`, `db-bootstrap`, `reconcile`, `maintain`, and the SPA |
| Infrastructure | Terraform: CloudFront, S3, VPC origin, ALB, ECS on EC2, RDS, Secrets Manager, EventBridge Scheduler, SNS |
| Tests | Go unit and real-PostgreSQL integration tests with fault injection; Vitest; Playwright against a real backend per test |

## Core guarantees

1. A checkout never reserves more stock than is available.
2. One idempotency key maps to one order, permanently.
3. Each reservation is settled or released exactly once.
4. A lost reply is treated as **unknown**, never as a rollback; the client retries with the same key and body.
5. The server is authoritative for prices, stock, ownership, roles and order state. Every request rechecks the session in the database.

## Out of scope

Real payments, refunds, taxes, shipping rates, product reviews, image upload, MFA, account deletion, and asynchronous processing (queues, workers, outbox). Payment is a deterministic simulation where the shopper chooses *accept* or *reject*. Asynchronous payments are the subject of a later project.
