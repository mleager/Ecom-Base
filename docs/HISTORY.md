# How it was built

Seventeen milestones, each closed by an acceptance run before the next began. Backend first, then the frontend against a fixed API, then the work that turns an application into something deployable: HTTPS, telemetry, packaging and a load-balanced AWS stack.

## Backend (Milestones 1–5)

| # | Milestone | What it delivered |
|---|---|---|
| 1 | Core database | Go module, PostgreSQL 16 in Compose, goose migrations, `sqlc`, configuration, and the first 13 tables with their constraints |
| 2 | Transactional orders | Checkout transaction T1: order, items, stock reservations and an idempotency key created atomically; safe under concurrent checkouts and a lost commit reply |
| 3 | Simulated payment | A committed processing claim, the deterministic accept/reject simulator, settlement transaction T2 and cancellation |
| 4 | Failure recovery | The `reconcile` command: idempotent finalisation of stranded orders, proven by crash tests that leak no reservations |
| 5 | Documentation and evidence | Architecture, schema and state diagrams; the API contract frozen for the frontend |

## Frontend (Milestones 6–13)

| # | Milestone | What it delivered |
|---|---|---|
| 6 | Design and API alignment | Pinned toolchain, routes and layouts, and an audit of gaps between the UI's needs and the API |
| 7 | Foundation and authentication | Vite/React/TypeScript app, a typed API boundary checked against OpenAPI, sign-up and sign-in with in-memory tokens and cross-tab coordination |
| 8 | Storefront and catalog | Product grid and detail pages, literal search, pagination, image fallbacks |
| 9 | Account, addresses and cart | Profile, addresses, versioned cart, and account security: password change and reset, email verification, session revocation, mail over TLS |
| 10 | Checkout and orders | Checkout recovery in the browser: the original key and body are saved before sending, so a crash or reload resumes the same request rather than repeating it |
| 11 | Administration and hardening | Product and inventory administration, with uncertain outcomes resolved by fresh reads rather than replayed writes |
| 12 | Visual design | A consistent visual system and responsive layouts, checked against a visual acceptance matrix |
| 13 | Shopping experience and guest checkout | Tailwind and shadcn components, quick view and a cart rail, and guest checkout with server-held shipping data, order history and recovery by email |

## Making it deployable (Milestones 14–17)

| # | Milestone | What it delivered |
|---|---|---|
| 14 | Production serving and HTTPS | The API serves the SPA and the API from one HTTPS origin; Secure cookies and HSTS rules; database TLS with `verify-full`; an HTTPS browser test group |
| 15 | Observability | OpenTelemetry traces, Prometheus metrics (HTTP, database pool, business counters), trace-linked logs, and a tested metric contract |
| 16 | Packaging | One distroless image with an embedded migration job, a Compose deployment with TLS everywhere, end-to-end deployment verification, and scripted release evidence |
| 17 | CDN and load-balanced API | CloudFront and S3 for the SPA, ECS tasks behind an internal ALB, rate limits shared in PostgreSQL, trusted client IPs, scheduled recovery, and a Terraform stack proven on AWS and destroyed |

M17 ended with two reviews (backend, then database and Terraform). Their fixes, and the defects found by running the stack on AWS ([terraform/DESIGN.md](terraform/DESIGN.md#defects-found-by-running-it)), are part of [release 1.0.0](RELEASE.md).

## Where it was developed

Milestones 1–17 were developed in a self-hosted Gitea instance. The repository moved to GitHub with release 1.0.0, with its full history; the earlier local tags were renamed to the milestone markers `m16-baseline` and `m17-cdn-alb` ([RELEASE.md](RELEASE.md#version-map)).

## What carried through

- **Decide, then build.** Each milestone opened by recording its decisions, so later changes could be checked against a stated reason ([DECISIONS.md](DECISIONS.md)).
- **Test against the real thing.** Integration tests use real PostgreSQL with injected faults; browser tests run against a real API and a fresh database per test; the AWS stack was exercised with forced failures, not only planned.
- **Keep the single-host path working.** Every milestone after 13 added a run mode without breaking the plain-HTTP developer loop or its 348 browser tests.
