# DevOps & Software Engineering Portfolio — Master Context

**Project Name:** Commerce Reliability Lab  
**Document Type:** Master Portfolio Context and Engineering Strategy  
**Version:** 1.1 (2026-11-08)  
**Status:** Project 1 in implementation (application milestones M1–M14 complete); Projects 2–7 planned  
**Primary Audience:** ChatGPT, OpenAI Codex, AI coding assistants, technical reviewers, and future contributors

## Revision 1.1 (2026-11-08)

Aligned with the Project 1 review:

- **Seven projects.** Projects 2–6 are scenario projects. Project 7 evolves the application itself. Numbering and repository names are now consistent throughout.
- **Scenario rule (§2.4).** Projects 2–6 never change application code. They run a released Project 1 version that already contains the observability instrumentation and metrics they need.
- **Observability split.** Project 1 ships the instrumentation, with telemetry off until it is configured. Project 4 owns the observability stack: Collector, Prometheus, Tempo, Loki, Grafana, dashboards, alerts and SLOs.
- **Project 1 facts (§5).** Status, technology choices, the 21-table schema and the resolved decisions (§21) now match the implementation.
- **Asynchronous processing** (outbox, SQS, workers, event contracts) belongs to Project 7 only.

---

# 1. Purpose of This Document

This document establishes the overall context, objectives, technical architecture, project boundaries, repository organization, documentation standards, and implementation strategy for a professional DevOps and Software Engineering portfolio.

It is intended to provide sufficient context for an AI assistant or software engineer to understand the portfolio without requiring access to previous conversations.

This document should be treated as the **portfolio-level source of truth** for agreed strategy and architectural direction.

However, project-specific technical specifications, architecture decision records (ADRs), and approved implementation plans will provide more detailed instructions for individual projects.

When implementation details are unspecified, the assistant should identify the missing decisions rather than silently inventing major requirements or architectural commitments.

## 1.1 Primary Objectives

The portfolio's primary objective is to demonstrate a combination of:

- Backend software engineering expertise.
- DevOps engineering expertise.
- Cloud infrastructure design and operations.
- Infrastructure as Code (IaC).
- CI/CD automation.
- System reliability engineering.
- Database administration and disaster recovery.
- Observability and troubleshooting.
- Security engineering and DevSecOps.
- Distributed systems engineering.
- Performance optimization.
- Incident response.
- Developer tooling and platform engineering.
- Professional technical documentation.
- Engineering decision-making and architectural tradeoff analysis.

The ultimate objective is to make the portfolio highly competitive for employment opportunities in:

1. DevOps Engineering
2. Software Engineering
3. Backend Engineering
4. Site Reliability Engineering (SRE)
5. Platform Engineering
6. Cloud Engineering

The portfolio should be credible to engineering hiring managers, technical interviewers, and experienced software developers.

## 1.2 Target Skill Level

The portfolio creator currently identifies as an **intermediate-level developer/engineer**.

The portfolio should therefore:

- Build on intermediate technical knowledge.
- Introduce more advanced engineering challenges.
- Demonstrate understanding rather than merely reproduce tutorials.
- Include realistic infrastructure and operational constraints.
- Challenge the creator to justify design decisions.
- Maintain practical and manageable implementation scope.
- Avoid unnecessary complexity introduced solely to include additional technologies.

The goal is to demonstrate advanced engineering practices through verifiable projects, not to misrepresent simulated experience as professional production experience.

---

# 2. Overall Portfolio Philosophy

## 2.1 Why This Portfolio Is Being Built

Traditional development portfolios frequently contain two or three completed web applications, such as task managers, e-commerce stores, or dashboards.

Although these applications can demonstrate programming ability, they do not necessarily prove an engineer can maintain, operate, troubleshoot, secure, recover, or scale a real production system.

Modern AI-assisted coding tools can also accelerate the generation of conventional application features and user interfaces.

Therefore, this portfolio will emphasize **engineering scenarios, reliability, operational challenges, and documented problem-solving** rather than simply showcasing completed applications.

The portfolio should answer questions such as:

- What happens when a production database loses critical data?
- How do we recover data without unnecessarily losing legitimate transactions?
- What happens when a software deployment introduces errors?
- How do we detect a failing release and safely roll it back?
- How can a distributed system prevent duplicate business operations?
- How do we investigate unexpected application latency?
- How do we identify and remediate insecure infrastructure?
- How do we automate infrastructure without creating unnecessary risk?
- How can a developer platform reduce repetitive engineering work?
- How do we measure whether a proposed solution actually works?

## 2.2 Guiding Principle

**Demonstrate engineering judgment, not merely familiarity with tools.**

Each project must demonstrate:

1. A realistic business or operational problem.
2. Clear engineering requirements.
3. A defensible technical design.
4. A functional implementation.
5. A reproducible failure or engineering challenge.
6. Investigation and diagnosis where appropriate.
7. A technically justified solution.
8. Automated verification.
9. Measured outcomes.
10. Clear documentation of tradeoffs, limitations, and lessons learned.

A project is not considered complete simply because its application runs or its infrastructure deploys successfully.

It is complete only after demonstrating that the intended engineering problem has been addressed and verified.

## 2.3 Simulated Production Scenarios

The projects will model scenarios commonly encountered in real production environments.

Examples include:

- Accidental deletion of database tables.
- Corrupted application data.
- Unsafe database migrations.
- Failed deployments.
- Application outages.
- Service dependency failures.
- Excessive database connections.
- Performance degradation under load.
- Overly permissive IAM permissions.
- Insecure network configurations.
- Duplicate messages.
- Failed asynchronous workers.
- Infrastructure provisioning failures.

All incidents will be deliberately simulated in controlled environments.

Documentation must clearly identify simulated incidents as simulations.

Do not present simulated lab experience as actual professional production experience.

## 2.4 Scenario Rule: No Application Code Changes

Projects 2–6 are **scenario projects**. Each one runs a released, versioned build of the Project 1 application and demonstrates operating it.

1. **Resolving a scenario never requires changing application source code.** Fixes use operational means: configuration, infrastructure, deployment and rollback, database administration, scaling, access control, automation and runbooks.
2. **Diagnosis uses the telemetry built into the release.** The baseline release already contains the traces, metrics and trace-linked logs the scenarios need (§5.6). Instrumentation is never added during an incident.
3. **Faults come from infrastructure or configuration first**, for example a stopped or slowed database, a wrong setting, an expired certificate, a full volume or injected network latency.
4. **When a fault must live inside the application** (a faulty release, an inefficient query, an unsafe migration), it ships as a prebuilt **fault-variant image** built from a documented branch or tag of the Project 1 repository (§3.3). The reviewer runs that image and never edits it.
5. **If an investigation shows that a code change is the right long-term fix**, the scenario records it as a finding and recommendation for a later Project 1 release. The scenario's own resolution stays operational.
6. **Scenario tooling is not application code.** Recovery validators, load-test scripts, Terraform, pipelines and the developer-platform CLI live in the scenario repositories.

**Project 7 is the exception.** It is an application evolution, a new major version of the application, not a scenario. Incidents may later be built on top of that version under the same rule.

---

# 3. Portfolio Architecture and Organization

## 3.1 Overall Portfolio Concept

The portfolio will use a shared fictional business environment.

**Working Name:** Commerce Reliability Lab

The fictional business operates an e-commerce platform containing customers, products, orders, inventory, and asynchronous order processing.

The application provides a consistent technical foundation for seven engineering projects: the application itself (Project 1), five scenario projects that operate it (Projects 2–6), and an application evolution (Project 7).

Instead of developing seven unrelated applications, the portfolio explores different engineering responsibilities associated with building, operating and maintaining the same business platform.

This creates a coherent engineering narrative.

## 3.2 GitHub Repository Strategy

**Finalized strategic decision: Each major project will have its own GitHub repository.**

The portfolio will contain seven project repositories and a separate portfolio landing-page repository.

Proposed repositories:

1. `01-order-processing`
2. `02-cicd-recovery`
3. `03-database-recovery`
4. `04-performance-engineering`
5. `05-cloud-security`
6. `06-developer-platform`
7. `07-async-order-processing`
8. `portfolio`

Repository names are proposed conventions and may be adjusted before creation.

Each repository should be independently understandable, documented, testable, and demonstrable.

The portfolio landing-page repository will connect the projects and present their combined engineering story.

## 3.3 Shared Application Strategy

The initial order-processing project will own the primary application source code.

Its technologies will include:

- Go backend.
- React frontend.
- TypeScript.
- Vite.
- PostgreSQL.
- Built-in observability instrumentation: OpenTelemetry traces and metrics, and trace-linked structured logs.
- Automated tests.
- Containerized deployment.

Asynchronous event processing is not part of Project 1; it is introduced by Project 7.

Subsequent project repositories consume **versioned application artifacts** built from the order-processing repository.

The baseline for every scenario is the first stable release, `v1.0.0` (released 2026-11-20 as tag `base-v1.0.0`, image `ghcr.io/mleager/ecom-base:1.0.0`):

- one container image that serves the API and the built React application from a single origin
- published to GitHub Container Registry and pinned by digest
- built-in instrumentation, with telemetry off until it is configured through environment variables, so the same image runs with or without an observability stack

Examples include:

- Pinned container image digests.
- Explicit application release tags.
- Versioned API contracts.
- Controlled experimental application builds.

This avoids duplicating the entire application source code across repositories.

### Why Source Duplication Is Avoided

Duplicating the same application across multiple repositories introduces:

- Maintenance overhead.
- Divergent application versions.
- Repeated bug fixes.
- Inconsistent security patches.
- Confusion about authoritative source code.
- Difficulty reproducing experiments reliably.

Instead, infrastructure and reliability projects should deploy known application releases.

### Fault Variants

Some scenario faults must live inside the application.

For example:

- A deliberately faulty release.
- An inefficient database query for performance testing.
- An unsafe database migration.

These are built as **fault-variant images** from documented branches or tags of the Project 1 repository and published like any other release, each as its own image repository: `ghcr.io/mleager/ecom-<variant>:<version>` (for example `ecom-cicd:1.0.0`), built from a git tag `<variant>-v<version>` in the Project 1 repository, never tagged `latest`. Each image carries an `io.github.mleager.ecom.variant` label and a description that states what is broken on purpose. Comparing the variant's tag with `base-v1.0.0` shows exactly what was broken. (Decided 2026-11-20; replaces the earlier single-repository example `ecommerce:s02-faulty-release`.)

Scenario repositories consume variant images by digest. They do not copy or edit application source (§2.4).

Variants are deliberate and documented. Infrastructure and configuration faults are preferred whenever they can reproduce the scenario.

## 3.4 Repository Independence

Each project repository should include:

- Its own README.
- Its own engineering requirements.
- Its own architecture documentation.
- Project-specific infrastructure.
- Project-specific testing.
- Failure simulation tooling.
- Operational runbooks.
- Results and engineering evidence.
- Instructions for reproducing the scenario.
- Commands for cleaning up resources.

Where practical, project workflows should provide commands resembling:

```bash
make lab-up
make test
make scenario-run
make lab-down
```

These are interface conventions, not a requirement to use Make specifically.

The intention is to reduce setup friction and allow a reviewer to reproduce the engineering scenario.

## 3.5 Project Relationships

The projects relate to one another as follows:

**Project 1: Order Processing**

Builds the foundational application, with built-in observability instrumentation, and demonstrates backend software engineering. Publishes the versioned releases every other project uses.

**Project 2: CI/CD Recovery**

Deploys versioned builds of Project 1 and demonstrates automated delivery, deployment failure detection, and rollback.

**Project 3: Database Recovery**

Deploys the application with a secured database and demonstrates backup, point-in-time recovery, and data reconciliation.

**Project 4: Performance Engineering**

Runs the observability stack against the application's built-in telemetry and demonstrates load testing, bottleneck identification, and operational optimization.

**Project 5: Cloud Security**

Examines and improves the security of infrastructure and deployment configurations associated with the application.

**Project 6: Developer Platform**

Automates and standardizes workflows demonstrated throughout the earlier projects.

**Project 7: Asynchronous Order Processing**

Evolves Project 1 into a new major application version: a payment provider integration, a transactional outbox, Amazon SQS, workers, retries and dead-letter queues. It is an application evolution, not a scenario (§2.4).

---

# 4. Technology Stack

## 4.1 Required Application Technologies

The following are established technology decisions.

### Backend

**Primary language: Go (Golang)**

Go will be used for:

- Backend API development.
- Business logic.
- Asynchronous workers.
- Automation utilities.
- Infrastructure-related tooling.
- Developer platform CLI development.

The implementation should demonstrate idiomatic Go engineering practices.

Recommended technologies include:

- Go standard library `net/http`.
- `chi` for HTTP routing.
- `pgx` for PostgreSQL connectivity.
- `sqlc` for type-safe database queries.
- Structured logging using Go's `log/slog` where appropriate.
- Go testing package.
- Testcontainers for integration tests when suitable.

These libraries are preferred starting points, not immutable architectural requirements. Final selections should be documented through ADRs where consequential.

Project 1's actual selections are listed in §5.2 and recorded in its DECISIONS.md.

### Frontend

**React + TypeScript + Vite**

The frontend will be used to demonstrate:

- Customer-facing order workflows.
- Inventory and product information.
- Order status.
- Error handling.
- Operationally relevant application behavior.
- Typed frontend/backend integration.

Recommended supporting technologies:

- React Router.
- TanStack Query.
- OpenAPI-derived TypeScript types or clients.
- Vitest.
- React Testing Library.
- Playwright.

Avoid unnecessary frontend complexity.

The frontend exists primarily to support the business workflows and reliability demonstrations, not to turn the portfolio into a UI design exercise.

### Database

**PostgreSQL**

Used for:

- Customers.
- Products.
- Inventory.
- Orders.
- Transactional consistency.
- Idempotency records.
- Outbox events (Project 7).
- Database recovery exercises.

Database operations should demonstrate:

- Transactions.
- Constraints.
- Appropriate indexes.
- Concurrency control.
- Transaction isolation.
- Data integrity.
- Migrations.
- Backup and recovery.

## 4.2 Infrastructure and DevOps Stack

Preferred technologies:

| Category | Technology |
|---|---|
| Cloud provider | AWS |
| Infrastructure as Code | Terraform |
| Containers | Docker |
| Local orchestration | Docker Compose |
| Kubernetes development | kind |
| Container orchestration | Kubernetes |
| Packaging | Helm |
| CI/CD | GitHub Actions |
| GitOps | Argo CD |
| Progressive delivery | Argo Rollouts |
| Metrics | Prometheus |
| Dashboards | Grafana |
| Tracing | OpenTelemetry + Tempo |
| Logging | Loki |
| Load testing | k6 |
| Container scanning | Trivy |
| IaC scanning | Checkov |
| Messaging | Amazon SQS |
| Database hosting | Amazon RDS for PostgreSQL |
| Secrets | AWS Secrets Manager |
| Container registry | GitHub Container Registry, unless a project requires another registry |

These technologies should be introduced incrementally.

Do not provision cloud infrastructure or Kubernetes clusters simply to include additional technologies.

Each component must have a documented engineering purpose.

## 4.3 Avoiding Unnecessary Complexity

Do not introduce additional complexity unless justified by a requirement.

Examples of technologies that should not be introduced automatically:

- Multiple cloud providers.
- Kafka when SQS is sufficient.
- Service meshes.
- Unnecessary microservices.
- Multiple backend programming languages.
- Complex distributed caching.
- Excessive abstraction layers.
- Premature platform frameworks.
- Production-scale infrastructure without corresponding workload requirements.

Engineering quality is more important than the number of technologies used.

---

# 5. Project 1 — Reliable Order Processing

**Repository**: 01-order-processing

**Primary Discipline**: Backend Software Engineering

**Secondary Disciplines**: Relational Database Design, Transactional Consistency, Concurrency, API Design, Testing, and Failure Recovery

**Status**: In implementation. Application milestones M1–M14 are complete:
- schema and services
- transactional orders and simulated payment
- recovery
- the React frontend and guest checkout
- production serving over HTTPS

Next: built-in observability instrumentation (M15), then the `v1.0.0` release image (M16). The repository's STATUS.md is authoritative for current progress.

## 5.1 Business Scenario

A fictional e-commerce company needs a dependable platform for customer accounts, product listings, carts, checkout, and order history. 
Products have limited stock, and overlapping checkout requests must not oversell inventory. 
Requests may be retried, and the application may crash while an order is awaiting its simulated payment result.

The engineering assignment is to build a reproducible Go and PostgreSQL system that handles these cases correctly, 
preserving order history and maintaining consistent inventory without premature distributed-systems complexity.

Project 1 is the foundational application consumed by later portfolio repositories through pinned, versioned releases. 
Production-style incidents are simulated in controlled labs, not represented as actual production experience.

## 5.2 Technology and Architecture

- **Backend:** Go modular monolith, go-chi/chi routing, pgx database driver, sqlc generated typed queries, goose SQL migrations, `log/slog` structured logging.
- **Frontend:** React, TypeScript, Vite, React Router, Tailwind CSS with project-owned shadcn components. Server data uses native `fetch`, React context and hooks; there is no TanStack Query or generated API client. The OpenAPI document is the API contract.
- **Database:** PostgreSQL (`postgres:16-alpine`) as the authoritative data store.
- **Development:** Docker Compose for PostgreSQL. Go unit tests, integration and concurrency tests against a local PostgreSQL container (not Testcontainers), Vitest and Testing Library component tests, and Playwright browser tests against the real API.
- **Serving:** the Go API serves the built frontend and the API from one HTTPS origin, with verified database TLS (`sslmode=verify-full`) in production mode.
- **Observability:** OpenTelemetry instrumentation built into the application (§5.6); the observability stack itself belongs to Project 4.
- **Deployment contract:** a single, versioned container image suitable for reuse by later projects.
- **No Project 1 dependency on:** Redis, SQS, SNS, outbox publisher, message broker, or background messaging workers.

Separate HTTP handlers, application/domain services, and database queries. 
Business services coordinate transactions; HTTP handlers do not implement inventory or payment rules. 
A dedicated maintenance command may reconcile incomplete checkout attempts, but it is not an asynchronous queue worker.

## 5.3 Core Functionality

### Customers and Authentication

Customers can register, sign in, sign out, view/update profile data, manage saved US shipping addresses, verify their email, change their email and password, and reset a forgotten password through an emailed link. 
Use short-lived JWT access tokens and server-tracked rotating refresh sessions. 
Protect customer-owned resources with authorization checks. Do not store plaintext passwords or refresh tokens.

### Guest checkout

Shoppers can also buy without an account. A guest session holds a cart and can check out with the same simulated payment. 
Guests can regain access to an order or an interrupted checkout through an emailed recovery link. 
When a guest signs in, they choose whether to keep the guest cart or the account cart.

### Products and Inventory

Customers can browse active products; authorized administrators can create, update (including partial updates), 
retire products, and apply validated stock adjustments. 
Products remain referentially available to historical orders. 
The inventory model tracks stock on hand and stock reserved, with available = on hand − reserved.

### Shopping cart

Each customer has one persistent active cart backed by PostgreSQL. 
Cart items reference products and quantities; adding an existing product updates its quantity. 
A cart does not reserve stock. Product prices and availability are re-evaluated on checkout. 
Cart mutations and checkout use consistent transactional locking/version checks to prevent concurrent cart changes from generating inconsistent orders.

### Orders and order items

Each checkout creates an order belonging to a customer with one or more order items. 
Items capture immutable product identity, quantity, and checkout-time price. 
Orders preserve a shipping-address snapshot and server-calculated totals so later product/profile edits do not rewrite purchase history. 
Customer APIs expose their own orders; order state transitions are restricted to authorized business operations, not unrestricted PATCH requests.

### Synchronous simulated payments

Use a small deterministic local payment simulator that returns accepted/rejected outcomes for an immutable payment attempt ID. 
No real payment gateway, card processing, messaging or distributed payment infrastructure is included. 
The simulator runs outside database transactions, does not create real financial side effects, and supports reproducible failure tests.

## 5.4 Checkout and Inventory Lifecycle

Checkout has two short PostgreSQL transactions separated by local payment simulation:

1. **Transaction 1 — create and reserve**: 
Validate authenticated customer and cart; enforce idempotency; lock/version the cart; read authoritative product prices; 
reserve stock with conditional updates; create the pending_payment order, order-item snapshots, per-item inventory reservations, 
and a pending payment attempt; associate the checkout idempotency key with the order; consume/clear the checked-out cart; commit atomically.

2. **Outside transaction — simulate payment**: 
Invoke the deterministic payment simulator using the persistent payment attempt identifier. 
No database lock should be held while simulating delay.

3. **Transaction 2 — settle**: 
Lock the relevant payment/order/reservation records; apply the previously determined outcome exactly once; 
if accepted, confirm the order and consume reservations (decrement both on-hand and reserved counts); 
if rejected, mark payment/order failed and release reservations (decrement reserved only); record any state transition; commit atomically.
If Transaction 1 fails, no partial order or reservation may persist. 
If the process crashes between transactions, the order remains recoverable. 
Repeating settlement must not consume or release a reservation twice. 
Pending outcomes should not be treated as failed solely because a request timed out.

## 5.5 Database Scope

The schema has 21 tables (13 goose migrations). The original 13-table design grew with account security and guest checkout:
1. Identity: users, user_sessions, addresses.
2. Account security: account_security_tokens, email_change_requests.
3. Catalog: products, inventory.
4. Cart: carts, cart_items.
5. Orders: orders, order_items, inventory_reservations, order_status_history.
6. Checkout/payment: checkout_idempotency, payment_attempts.
7. Guest commerce: guest_principals, guest_sessions, guest_cart_choices, guest_checkout_intents, guest_recovery_tokens, guest_recovery_sessions.

Use UUID primary keys; snake_case; TIMESTAMPTZ; integer minor units for USD monetary values; 
explicit foreign keys, unique indexes, and nonnegative/positive checks. 
Store historical order item and address snapshots. 
Constrained status values and guarded transitions must agree. 
Detailed columns and migration ordering live in the Project 1 database documentation and subsequent SQL migrations, not here.

## 5.6 Key Engineering Requirements

**Prevent overselling**
Concurrent checkout requests must never commit reservations exceeding physical stock. 
Use atomic conditional SQL updates or appropriate row locking; multiple-product checkout must succeed or fail as one transaction. 
Preserve quantity_on_hand >= quantity_reserved >= 0.

**Idempotent checkout**
Scope checkout idempotency keys to the customer; fingerprint canonical request inputs; 
return the existing order/status for equivalent retries; reject a reused key with a different payload. 
Prevent two different keys from creating separate orders from the same checked-out cart version. 
Define retention and concurrent-request behavior before implementation.

**Recover incomplete payments and reservations**
Persist the payment attempt and reservation ownership. 
Supply an explicit Go reconciliation/maintenance command for eligible incomplete simulated checkouts and expired reservations. 
The simulator must reproduce the same outcome for the same attempt ID; recovery must coordinate with checkout settlement and never race a valid in-progress attempt into an incorrect cancellation.

**Testability and observability**
Provide health/readiness endpoints, structured logs, documented test fixtures, and repeatable failure tests. 
The application ships the instrumentation every scenario relies on, because scenarios cannot add it later (§2.4):

- OpenTelemetry traces for HTTP requests (named by route pattern), database queries (statement text, never arguments) and email sends.
- Prometheus metrics on a separate internal listener (`METRICS_ADDR`):
  - request rate, errors and latency
  - database pool and Go runtime metrics
  - business counters: orders, payment results, unknown checkout outcomes, guest sessions, rate-limit rejections and email failures
- `trace_id` and `span_id` in the JSON request logs, next to `request_id`.
- **Off by default.** Nothing is exported until the standard `OTEL_*` variables are set, and a missing or slow collector never delays requests.
- No secrets or personal data in spans, metric labels or logs. Metric labels are bounded and never contain user, order or session IDs.

Project 1 verifies the instrumentation with tests and a minimal collector check. It does not deploy dashboards, alerting or a log store; those belong to Project 4.

**Operational configurability**
Settings a scenario must tune without code changes are exposed as configuration. The database connection-pool size is one of them. It is currently fixed in code, so it must become configurable before `v1.0.0` (needed by Project 4's connection-exhaustion experiment).

## 5.7 Primary Failure Scenarios

1. Many customers attempt to buy the final unit; at most one unit is successfully reserved.
2. A checkout request is repeated with the same key; no duplicate order or stock reservation appears.
3. Concurrent checkout attempts use different keys against the same cart version; only one order is created for that version.
4. A simulated payment is rejected; the order remains recorded and its reservation is released once.
5. The application crashes after the first commit and before payment finalization; a recovery command reconciles it safely.
6. Settlement or its HTTP response is repeated; inventory and payment outcomes remain correct.
7. A product or saved address changes after purchase; historical order snapshots remain unchanged.

## 5.8 Expected Deliverables

- Go REST API, React/TypeScript/Vite frontend, PostgreSQL schema and versioned goose migrations.
- sqlc query definitions and generated access layer; transaction-coordinating Go services.
- Persistent cart, inventory reservations, orders/order items, JWT-based authentication, simulated payments, and maintenance/recovery CLI.
- OpenAPI contract; Docker Compose local environment; container build and versioned release process.
- Built-in OpenTelemetry instrumentation (§5.6), off by default.
- Release `v1.0.0`: one image serving the API and frontend, published to GitHub Container Registry with its digest recorded.
- Automated unit, database integration, concurrency, idempotency, recovery, API, and relevant frontend tests.
- Architecture and relationship diagrams; README, project requirements, technical design, test plan, operational guide, ADRs, and verified experiment evidence.

## 5.9 Definition of Done

- Customer, catalog, cart, checkout, and order workflows satisfy documented acceptance criteria.
- Concurrency tests demonstrate no overselling under tested workloads and database constraints remain intact.
- Duplicate and conflicting checkout requests behave predictably; repeated settlement does not alter settled inventory again.
- Accepted/rejected payment simulations produce correct order and reservation transitions.
- Crash recovery is reproducible without orphaned active reservations or invented payment outcomes.
- Historical product, price, and delivery details remain accurate after source-record changes.
- A new engineer can start, test, reproduce failures, and tear down the environment from documentation.
- Container artifacts can be published and consumed at pinned versions by other projects.
- The released image emits the traces, metrics and trace-linked logs in §5.6 when telemetry is configured, and behaves exactly as before when it is not.
- Actual test results and limitations are documented honestly; documentation matches implemented behavior.

## 5.10 Explicitly Deferred to Project 7

Project 7 (`07-async-order-processing`, proposed) will evolve this working checkout model to handle real asynchronous boundaries: 
transactional outbox, SQS, durable publishers/workers, at-least-once delivery, retries, dead-letter queues, provider callbacks, unknown remote payment outcomes, reconciliation, and compatibility-preserving migration of the existing system.

Project 1 must not add these prematurely. Its objective is to establish correct transactional business behavior that can later be extended and tested against harder distributed failure modes.

---

# 6. Project 2 — CI/CD Recovery and Progressive Deployment

**Repository:** `02-cicd-recovery`

**Primary Discipline:** DevOps Engineering

**Secondary Disciplines:** SRE, Release Engineering, Application Reliability

## 6.1 Business Scenario

An application update passes ordinary automated tests but introduces a production-style regression.

The deployment causes elevated error rates, increased latency, or failing health checks.

The engineering assignment is to design a delivery pipeline that detects and responds to unsafe deployments.

Detection uses the request, error and latency metrics built into the application release (§5.6). Faulty releases are prebuilt fault-variant images (§3.3); responding to them never requires changing application code (§2.4).

## 6.2 Main Technologies

- GitHub Actions.
- Docker.
- GitHub Container Registry.
- Kubernetes.
- Helm.
- Argo CD.
- Argo Rollouts.
- Prometheus.
- Grafana.
- Terraform where infrastructure provisioning requires it.

## 6.3 Functional Requirements

Build a pipeline that:

1. Runs automated tests.
2. Performs security scanning.
3. Builds container images.
4. Publishes versioned artifacts.
5. Deploys approved versions.
6. Supports canary releases.
7. Monitors deployment health.
8. Aborts unhealthy rollouts.
9. Supports rollback to compatible application versions.
10. Records deployment events for investigation.

## 6.4 Failure Scenarios

### Faulty Application Release

Deploy a fault-variant release that causes some API requests to fail.

Verify the system detects the regression from the application's metrics and halts or reverses the rollout.

### Failing Health Checks

Deploy a version that fails readiness or application health criteria.

Demonstrate safe deployment behavior.

### Unsafe Database Migration

Deploy a fault-variant release whose schema change complicates rolling back application code.

Recover operationally, then demonstrate backward-compatible migration practices using an expand-and-contract strategy, shown with prebuilt release images rather than code edits.

## 6.5 Expected Evidence

- Pipeline execution logs.
- Container image version information.
- Canary deployment metrics.
- Deployment failure graphs.
- Rollback evidence.
- Recovery timeline.
- Incident postmortem.
- Compatibility analysis.

The project should differentiate application rollback from database recovery and explain when rollback is unsafe.

---

# 7. Project 3 — Secure Database and Disaster Recovery

**Repository:** `03-database-recovery`

**Primary Discipline:** Database Reliability / DevOps

**Secondary Disciplines:** Cloud Engineering, Security, Incident Response

## 7.1 Business Scenario

An engineer accidentally deploys a destructive database migration that removes critical customer order records.

The system must recover the affected records while minimizing operational disruption and avoiding unnecessary loss of legitimate post-incident transactions.

## 7.2 Main Technologies

- PostgreSQL.
- Amazon RDS.
- AWS networking and security groups.
- Terraform.
- AWS Secrets Manager.
- RDS automated backups.
- Point-in-time recovery.
- Go-based recovery validation tools where useful (scenario tooling, not application changes).

## 7.3 Functional Requirements

Demonstrate:

1. Private database networking.
2. Least-privilege application credentials.
3. Secure credential storage.
4. Automated backups.
5. Recovery readiness validation.
6. Point-in-time restoration to a separate instance.
7. Affected-data recovery.
8. Data integrity verification.
9. Reconciliation of valid post-incident transactions.
10. Recovery reporting.

## 7.4 Failure Scenarios

### Accidental Table Deletion

Delete the orders table in a controlled environment.

Restore the database to an appropriate recovery point.

### Partial Data Corruption

Corrupt a subset of records.

Determine whether surgical recovery or another repair method is appropriate.

### Failed Database Migration

Apply a defective migration shipped in a fault-variant image and document recovery options.

## 7.5 Reliability Metrics

Define and evaluate:

- Recovery Time Objective (RTO).
- Recovery Point Objective (RPO).
- Actual recovery duration.
- Actual or potential data loss.
- Integrity validation results.
- Recovery procedure repeatability.

Do not claim zero data loss unless the experimental evidence supports that claim.

## 7.6 Critical Engineering Principle

Restoring an entire production database to an earlier point can erase valid writes made after the incident.

Recovery design must address this risk.

A restored database should generally be isolated until its recovered data has been validated and an appropriate recovery or reconciliation plan has been approved.

## 7.7 Expected Evidence

- AWS architecture diagram.
- Terraform configurations.
- Backup settings.
- Recovery timeline.
- Recovery procedure.
- Data validation results.
- Incident report.
- RTO/RPO evaluation.

---

# 8. Project 4 — Performance Engineering and Production Outages

**Repository:** `04-performance-engineering`

**Primary Discipline:** Site Reliability Engineering

**Secondary Disciplines:** Backend Engineering, Database Performance, Observability

## 8.1 Business Scenario

A large traffic increase causes slow responses, failed checkout requests, and infrastructure stress.

The engineering assignment is to identify bottlenecks, implement appropriate operational improvements, and prove their effectiveness.

This project owns the observability stack. It collects the telemetry built into the application release (§5.6) and adds dashboards, alert rules, SLOs and load tests. Improvements are operational (§2.4): database administration, configuration, pooling, scaling and infrastructure. Where the real fix is an application change, such as a query rewrite or caching, it is recorded as a recommendation for a later Project 1 release.

## 8.2 Main Technologies

- The application's built-in OpenTelemetry instrumentation (Project 1).
- OpenTelemetry Collector.
- PostgreSQL.
- Prometheus.
- Grafana.
- Tempo.
- Loki.
- k6.
- Toxiproxy or similar for injected latency.
- Kubernetes where relevant.

## 8.3 Main Experiments

### Inefficient Database Queries

Identify expensive queries from traces and database statistics, using a fault-variant image where the slow query must be introduced.

Analyze execution plans and improve them with database administration: indexes, statistics and configuration.

### Database Connection Exhaustion

Demonstrate that adding application replicas can worsen database connection pressure.

Investigate pooling and connection limits, and tune them through configuration (§5.6).

### Increased Traffic

Generate repeatable workloads and identify the point where the system violates performance objectives.

### Slow Downstream Dependencies

Introduce latency into a dependency, such as the database or the mail server.

Evaluate the application's existing timeouts and protective mechanisms, and infrastructure-level mitigations.

## 8.4 Measured Metrics

Include:

- Requests per second.
- P50 latency.
- P95 latency.
- P99 latency where meaningful.
- HTTP error rates.
- Database CPU.
- Memory utilization.
- Database connections.
- Container resource utilization.
- Cost or resource-efficiency considerations.

Define performance targets before conducting experiments.

Do not invent benchmark results.

## 8.5 Expected Evidence

- Load testing scripts.
- Grafana dashboards.
- Distributed traces.
- Query execution plans.
- Before-and-after measurements.
- Root-cause analysis.
- Optimization explanation.
- Limitations and follow-up recommendations.

---

# 9. Project 5 — Cloud Security Audit and Remediation

**Repository:** `05-cloud-security`

**Primary Discipline:** DevSecOps / Cloud Security

**Secondary Disciplines:** Infrastructure Engineering, CI/CD Security

## 9.1 Business Scenario

A fictional infrastructure security audit identifies excessive permissions, weak network restrictions, insecure secrets handling, or outdated dependencies.

The engineering assignment is to identify and remediate these issues while preserving legitimate application functionality.

## 9.2 Main Technologies

- AWS IAM.
- AWS VPC and security groups.
- Terraform.
- GitHub Actions.
- Trivy.
- Checkov.
- AWS Secrets Manager.
- GitHub OIDC integration with AWS.

## 9.3 Main Requirements

- Establish an infrastructure security baseline.
- Identify known misconfigurations.
- Evaluate risk severity.
- Apply least-privilege IAM controls.
- Restrict network connectivity.
- Protect application secrets.
- Scan infrastructure definitions.
- Scan application dependencies and images. Remediate application vulnerabilities by deploying a patched Project 1 release, not by editing code in this repository.
- Add preventive CI/CD controls.
- Test allowed and denied access.

## 9.4 Lab Safety

Intentionally insecure configurations must be evaluated only in a restricted, disposable lab.

Avoid exposing vulnerable services to the public internet.

Never use real customer data or production credentials.

The lab must have documented teardown procedures.

## 9.5 Expected Evidence

- Threat model.
- IAM permission matrix.
- Sanitized security scan results.
- Before-and-after configurations.
- Access verification tests.
- Remediation report.
- Residual risk discussion.

---

# 10. Project 6 — Internal Developer Platform

**Repository:** `06-developer-platform`

**Primary Discipline:** Platform Engineering

**Secondary Disciplines:** Go Software Engineering, DevOps Automation

## 10.1 Business Scenario

Developers at the fictional company must repeatedly configure repositories, CI/CD pipelines, containers, infrastructure, security checks, and monitoring.

Manual setup is inconsistent and time-consuming.

The engineering assignment is to create a standardized self-service developer workflow.

## 10.2 Main Deliverable

A developer CLI written in Go.

Illustrative command:

```bash
devplatform create service inventory-api \
  --language go \
  --database postgres \
  --environment dev
```

The CLI should validate configuration and execute or initiate a controlled provisioning workflow.

## 10.3 Functional Requirements

Support:

- Service template selection.
- Project configuration.
- Repository setup or generation.
- CI/CD workflow generation.
- Container build configuration.
- Kubernetes or deployment configuration.
- Terraform inputs.
- Environment configuration.
- Monitoring defaults.
- Security scanning defaults.
- Provisioning state reporting.
- Service decommissioning.

## 10.4 Engineering Challenges

Address:

- Idempotent provisioning.
- Duplicate service names.
- Input validation.
- Partial provisioning failures.
- Retry behavior.
- Resource cleanup.
- Drift detection.
- Configuration changes.
- Permissions and approval controls.
- Safe teardown.

## 10.5 Optional Expansion

Backstage may be introduced as an optional user interface after the Go CLI and its workflows are functional.

Do not make Backstage a prerequisite.

## 10.6 Expected Evidence

- Working CLI.
- Automated tests.
- Service templates.
- Provisioning demonstrations.
- Failure-handling tests.
- Generated service examples.
- Setup-time comparisons.
- Engineering design documentation.

---

# 11. Project 7 — Asynchronous Order Processing

**Repository:** `07-async-order-processing`

**Primary Discipline:** Distributed Systems Engineering

**Secondary Disciplines:** Backend Engineering, Reliability, Cloud Messaging

**Status:** Planned. Scope is defined in §5.10; detailed requirements will be written when the project starts.

## 11.1 Business Scenario

The business moves from a simulated synchronous payment to an external payment provider whose results arrive asynchronously. 
Payment and order events can now be delayed, duplicated, reordered or lost in transit.

## 11.2 Nature of the Project

Unlike Projects 2–6, this project changes the application. It produces a new major version (`v2.0.0`) of the Project 1 application, developed in the Project 1 codebase or a documented fork of it. 
Scenario-style incidents (for example a broker outage, duplicate deliveries or an outbox backlog) may later be built on `v2.0.0` under the rule in §2.4.

## 11.3 Main Technologies

- Go.
- PostgreSQL transactional outbox.
- Amazon SQS, with a local equivalent for development.
- Workers with retries and dead-letter queues.
- OpenTelemetry trace context carried through messages.

## 11.4 Expected Evidence

- Duplicate, delayed and lost-message tests with database verification.
- Retry and dead-letter behavior.
- Reconciliation of unknown remote payment outcomes.
- Compatibility-preserving migration from `v1.x` data.
- Traces that follow one order across the API, the outbox and the workers.

---

# 12. Standard Repository Documentation

Every project will follow a consistent documentation framework.

## 12.1 Core Documentation

Each repository should include the following documentation or its equivalent:

| Document | Responsibility |
|---|---|
| README.md | Public project overview and navigation |
| AGENTS.md | Instructions for AI coding assistants |
| PROJECT_STATUS.md | Current implementation status |
| PROJECT_BRIEF.md | Business context and engineering problem |
| PRD.md | Functional and nonfunctional requirements |
| ARCHITECTURE.md | High-level system architecture |
| TECHNICAL_DESIGN.md | Detailed engineering implementation |
| IMPLEMENTATION_PLAN.md | Ordered implementation milestones |
| TEST_PLAN.md | Verification strategy and acceptance criteria |
| SECURITY.md | Security requirements and controls |
| DEPLOYMENT.md | Environment setup, deployment and teardown |
| RUNBOOK.md | Operational procedures |
| RESULTS.md | Experiments, evidence and conclusions |
| adr/ | Architecture Decision Records |

Documentation should be proportionate to the actual complexity of the project.

Do not create unnecessarily lengthy documents simply for the appearance of completeness.

Every document should provide useful engineering context.

## 12.2 README.md

The README should communicate the project's value to a hiring manager or reviewer.

It should include:

- Project title.
- Business scenario.
- Engineering problem.
- Solution summary.
- Technologies.
- Architecture diagram.
- Key features.
- Demonstrated failure scenarios.
- Quick-start instructions.
- How to run tests.
- Links to technical documentation.
- Results and evidence.
- Limitations.
- Related portfolio projects.

## 12.3 PROJECT_BRIEF.md

Define:

- Fictional company context.
- Business operations.
- Engineering assignment.
- Current problem.
- Business impact.
- Constraints.
- Assumptions.
- Expected outcome.
- Scope boundaries.

## 12.4 PRD.md

Define:

- Functional requirements.
- Nonfunctional requirements.
- User stories where applicable.
- Failure behavior.
- Acceptance criteria.
- Performance expectations.
- Availability expectations.
- Security requirements.
- Out-of-scope functionality.

Requirements should use stable identifiers.

Examples:

- FR-001
- FR-002
- NFR-001
- SEC-001

## 12.5 ARCHITECTURE.md

Document:

- System context.
- Components.
- Service boundaries.
- External dependencies.
- Data flows.
- Network boundaries.
- Deployment topology.
- Reliability considerations.
- Security trust boundaries.
- Architectural tradeoffs.

Use Mermaid diagrams where appropriate.

## 12.6 TECHNICAL_DESIGN.md

Provide sufficient technical detail to guide implementation.

For Go applications, include:

- Package responsibilities.
- Interfaces.
- Domain models.
- Application service boundaries.
- Database access.
- Transactions.
- Error handling.
- API contracts.
- Concurrency behavior.
- Worker lifecycle.
- Context propagation.
- Shutdown behavior.

For React applications, include:

- Component architecture.
- Routing.
- TypeScript types.
- API integration.
- State management.
- Validation.
- Error states.
- Accessibility expectations.
- Frontend testing.

For infrastructure projects, include:

- Resource architecture.
- Terraform modules.
- Environment variables.
- Secrets.
- Network configuration.
- IAM.
- Deployment strategy.
- Failure recovery.
- Resource lifecycle.

## 12.7 IMPLEMENTATION_PLAN.md

Break implementation into manageable milestones.

Each milestone should identify:

- Objective.
- Requirements addressed.
- Dependencies.
- Components or files affected.
- Engineering tasks.
- Tests.
- Acceptance criteria.
- Completion status.

Implementation should proceed in small, verifiable increments.

## 12.8 TEST_PLAN.md

Define:

- Unit tests.
- Integration tests.
- API contract tests.
- Frontend component tests.
- End-to-end tests.
- Concurrency tests.
- Race detection.
- Security tests.
- Failure-injection tests.
- Infrastructure validation.
- Performance tests where applicable.

Each requirement should be linked to a verification method.

## 12.9 SECURITY.md

Include:

- Threat model.
- Trust boundaries.
- Authentication.
- Authorization.
- Secrets.
- Encryption.
- Network controls.
- IAM.
- Input validation.
- Dependency security.
- Security testing.
- Known residual risks.

## 12.10 DEPLOYMENT.md

Include:

- Prerequisites.
- Local installation.
- Environment configuration.
- Application builds.
- Container configuration.
- Infrastructure provisioning.
- Database migrations.
- Deployment.
- Verification.
- Rollback.
- Teardown.
- Cloud cost considerations.

## 12.11 RUNBOOK.md

Include:

- Health checks.
- Monitoring.
- Logs.
- Traces.
- Alert interpretation.
- Diagnostic commands.
- Failure symptoms.
- Incident response procedures.
- Recovery steps.
- Verification after recovery.

## 12.12 RESULTS.md

Include:

- Experiment objectives.
- Test environment.
- Methodology.
- Observations.
- Actual measurements.
- Relevant logs and screenshots.
- Conclusions.
- Limitations.
- Proposed improvements.

Do not present hypothetical measurements as actual results.

## 12.13 Architecture Decision Records

Use ADRs to capture important technical decisions.

Each ADR should include:

- Title.
- Status.
- Context.
- Decision.
- Alternatives.
- Rationale.
- Consequences.
- Risks.

Example ADRs:

- Choosing Go HTTP routing.
- Choosing pgx and sqlc.
- Selecting PostgreSQL locking strategies.
- Using a transactional outbox.
- Using SQS rather than Kafka.
- Selecting GitOps deployment patterns.
- Choosing a managed database over self-hosting.

---

# 13. Additional Documentation by Project

Each project will add specialized documentation as necessary.

## Project 1

- DATABASE_SCHEMA.md
- CONCURRENCY_DESIGN.md
- OBSERVABILITY_CONTRACT.md (the telemetry the release emits: span names, metric names and labels, log fields)
- OpenAPI specification

Project 1 began before this standard was written. Its existing documents (overview, status, milestones, decisions, operations and testing guides) are mapped or renamed to this set at the `v1.0.0` release rather than rewritten.

## Project 2

- PIPELINE_DESIGN.md
- RELEASE_STRATEGY.md
- ROLLBACK_PLAN.md

## Project 3

- BACKUP_STRATEGY.md
- RECOVERY_PLAN.md
- DATA_VALIDATION.md

## Project 4

- OBSERVABILITY.md
- LOAD_TEST_PLAN.md
- SLO.md

## Project 5

- THREAT_MODEL.md
- IAM_MATRIX.md
- REMEDIATION_PLAN.md

## Project 6

- PLATFORM_CONTRACT.md
- CLI_SPEC.md
- PROVISIONING_LIFECYCLE.md

## Project 7

- EVENT_CONTRACTS.md
- OUTBOX_DESIGN.md
- MIGRATION_FROM_V1.md

---

# 14. AI-Assisted Development Strategy

The portfolio will be built with assistance from OpenAI Codex and potentially ChatGPT.

AI tools should accelerate implementation, documentation, testing, and troubleshooting.

However, AI-generated output must still meet professional engineering standards.

## 14.1 Role of Codex

Codex may assist with:

- Repository setup.
- Application implementation.
- Infrastructure definitions.
- Unit and integration tests.
- Refactoring.
- Debugging.
- Documentation generation.
- CI/CD workflows.
- Automation scripts.
- Technical reviews.

Codex should operate as an engineering implementation assistant, not as the sole authority over product requirements or architectural decisions.

## 14.2 Required Context

Before implementing meaningful changes, Codex should review:

1. This portfolio master context when relevant.
2. Repository AGENTS.md.
3. Project brief.
4. Project PRD.
5. Architecture.
6. Technical design.
7. Relevant ADRs.
8. Implementation plan.
9. Test plan.
10. Existing implementation and status.

Not all documents must be reread in full for trivial changes. The goal is sufficient context for safe, accurate implementation.

## 14.3 Implementation Rules

Codex should:

- Follow documented requirements.
- Respect established architecture.
- Use idiomatic Go.
- Use strict TypeScript conventions.
- Avoid undocumented dependencies.
- Avoid unnecessary abstractions.
- Maintain consistent error handling.
- Write appropriate automated tests.
- Avoid committing credentials.
- Avoid weakening tests to make them pass.
- Maintain backward compatibility where required.
- Update documentation when implementation changes.
- Report assumptions and limitations.
- Highlight inconsistencies between code and documentation.

## 14.4 Working in Small Milestones

Avoid instructions such as:

"Build the entire application."

Prefer controlled tasks such as:

"Implement the order creation endpoint according to FR-003, the approved SQL transaction design, and the existing API specification. Add tests covering successful order creation, insufficient inventory, and concurrent requests."

Each implementation step should include:

- Requirements.
- Relevant architecture.
- Expected behavior.
- Constraints.
- Acceptance criteria.
- Verification commands.

## 14.5 Definition of Done for Agent Tasks

A task is considered complete when:

- Required behavior is implemented.
- Relevant tests pass.
- Formatting passes.
- Static analysis passes where configured.
- No known security constraints are violated.
- Documentation is updated when necessary.
- Unverified behavior is disclosed.
- The implementation is consistent with architectural decisions.

Do not report test execution as successful unless it was actually executed successfully.

If execution was not possible, report that explicitly.

## 14.6 Engineering Ownership

AI assistance does not replace engineering judgment.

The portfolio creator must be able to explain:

- Why the architecture was selected.
- How important code paths work.
- What assumptions the system makes.
- Which failure modes were considered.
- Why security controls are appropriate.
- What the test results prove.
- What limitations remain.

The ability to independently defend the implementation is a central portfolio requirement.

---

# 15. Engineering Quality Standards

## 15.1 Backend Standards

Go code should emphasize:

- Simplicity.
- Clear package boundaries.
- Explicit dependencies.
- Idiomatic error handling.
- Context-aware operations.
- Resource cleanup.
- Safe concurrency.
- Structured logging.
- Testability.
- Appropriate interfaces.
- Graceful shutdown.

Avoid excessive abstractions that make basic behavior difficult to understand.

## 15.2 Frontend Standards

React and TypeScript code should emphasize:

- Strong typing.
- Separation of concerns.
- Reusable components where justified.
- Accessible UI.
- Clear loading states.
- Clear error states.
- API contract consistency.
- Predictable data fetching.
- Component testing.
- End-to-end testing for important workflows.

## 15.3 Database Standards

Database design should emphasize:

- Data integrity.
- Appropriate constraints.
- Explicit transaction boundaries.
- Efficient indexing.
- Safe migrations.
- Consistency under concurrency.
- Recoverability.
- Least-privilege access.

## 15.4 Infrastructure Standards

Infrastructure should be:

- Version-controlled.
- Reproducible.
- Documented.
- Minimally privileged.
- Secure by default.
- Cost-conscious.
- Destroyable without unnecessary manual cleanup.

## 15.5 Observability Standards

Where relevant, projects should provide:

- Structured logs.
- Meaningful metrics.
- Distributed traces.
- Health endpoints.
- Alerting.
- Correlation identifiers.
- Dashboards.
- Documented response procedures.

Metrics should relate to real system behavior rather than simply demonstrate that monitoring tools are installed.

Instrumentation belongs to the application (Project 1); collection, storage, dashboards and alerting belong to the projects that operate it (Project 4 owns the full stack; other scenarios bring only the parts they need, for example Prometheus for Project 2's rollout analysis).

---

# 16. Verification and Engineering Evidence

Every project must include objective evidence of its engineering claims.

Examples:

| Claim | Required evidence |
|---|---|
| Concurrent purchases are safe | Automated concurrent purchase tests and integrity checks |
| Duplicate events are handled | Retry/redelivery tests and database verification |
| Failed releases are detected | Monitoring data and rollout events |
| Rollback works | Reproducible deployment failure and recovery evidence |
| Database recovery works | Restore logs, integrity checks, measured recovery results |
| Performance improved | Comparable before-and-after load tests |
| Infrastructure is secured | Scan reports and access-control verification |
| Developer tooling saves time | Repeated setup measurements and successful generated deployments |

Evidence should distinguish:

- Intended behavior.
- Automated test results.
- Experimentally observed behavior.
- Assumptions.
- Known limitations.

No fabricated test outcomes, performance measurements, uptime claims, or recovery statistics should appear in the published portfolio.

---

# 17. Portfolio Presentation Strategy

## 17.1 Intended Audience

The portfolio must be accessible to:

- Technical recruiters.
- Hiring managers.
- DevOps engineers.
- Backend engineers.
- SRE engineers.
- Platform engineers.

## 17.2 Reviewer Experience

A reviewer should be able to understand a project within approximately two minutes.

Each README should quickly answer:

1. What problem does the project solve?
2. Why does the problem matter?
3. What was built?
4. What engineering challenges were addressed?
5. How was the solution verified?
6. Where can I inspect the implementation?
7. How can I reproduce the results?

## 17.3 Demonstration Videos

Where practical, include short demonstrations showing:

- Healthy initial conditions.
- A controlled failure.
- Detection or diagnosis.
- Recovery or remediation.
- Verification.
- Measured results.

Videos should supplement, not replace, source code and technical documentation.

## 17.4 Portfolio Landing Page

The `portfolio` repository should provide:

- Personal technical introduction.
- Portfolio overview.
- Shared system architecture.
- Seven project summaries.
- Links to repositories.
- Architecture diagrams.
- Engineering case studies.
- Demonstration links.
- Technologies demonstrated.
- Measured results.
- Areas of specialization.

It should emphasize engineering outcomes rather than a large list of tools.

---

# 18. Suggested Implementation Order

The current recommended sequence is:

| Order | Project | Primary outcome |
|---|---|---|
| 1 | Order Processing | Backend engineering foundation |
| 2 | CI/CD Recovery | Automated delivery and deployment reliability |
| 3 | Database Recovery | Data protection and recovery |
| 4 | Performance Engineering | Observability and optimization |
| 5 | Cloud Security | Infrastructure security |
| 6 | Developer Platform | Reusable engineering automation |
| 7 | Asynchronous Order Processing | Distributed-systems evolution of the application (`v2.0.0`) |

## 18.1 Suggested Timeline

A preliminary part-time planning estimate is approximately 12–16 weeks.

This assumes consistent availability and an implementation scope that remains controlled.

The schedule should be adjusted based on actual progress.

Engineering depth matters more than meeting an arbitrary deadline.

## 18.2 Job Application Milestone

Project 1's `v1.0.0` release must exist before any scenario project starts, because every scenario runs it.

The first three completed projects should provide sufficient breadth to begin applying for appropriate roles while continuing to develop the remaining projects.

Do not postpone applications simply because every proposed project is not yet complete.

## 18.3 Quality Over Quantity

Three thoroughly documented, tested, and demonstrated engineering projects are more valuable than seven incomplete or superficial projects.

Projects should only be presented as complete when their definitions of done are satisfied.

---

# 19. AWS Cost and Environment Strategy

Cloud infrastructure should be used selectively.

## 19.1 Local Development First

Prefer local environments for:

- Application development.
- Unit tests.
- Database integration tests.
- Docker Compose.
- Local Kubernetes experimentation.
- General failure injection.

## 19.2 Cloud Infrastructure When Justified

Use AWS to demonstrate capabilities that are specifically related to managed cloud services, such as:

- RDS recovery.
- IAM.
- Cloud networking.
- Secrets management.
- Cloud infrastructure provisioning.
- Managed messaging.

## 19.3 Cost Controls

All AWS projects should include:

- Budget awareness.
- Cost estimates where feasible.
- Resource tagging.
- Short-lived environments.
- Cleanup scripts.
- Teardown verification.
- Documentation of recurring charges.

AWS budget notifications are not hard spending limits.

Do not leave expensive infrastructure running unnecessarily.

Do not create billable resources without explicit authorization when acting through an AI agent with infrastructure access.

---

# 20. Cross-Repository Conventions

The portfolio should have consistent standards across repositories.

## 20.1 Repository Naming

Use descriptive names that reflect the primary engineering purpose.

The numbered prefixes indicate the recommended learning and implementation sequence.

## 20.2 Versioning

Publish identifiable application versions.

Infrastructure projects should pin specific application artifacts.

For container images, immutable digests are preferred for reproducible deployments.

Record the exact application version used in experiments.

## 20.3 Documentation Consistency

Use similar document names and structure across projects.

Avoid maintaining conflicting copies of authoritative contracts.

Examples:

- OpenAPI specifications own API schemas.
- Database migrations represent the executable database schema.
- ADRs record architectural decisions.
- PRDs define approved requirements.
- Test plans map requirements to verification.
- Results documents record observed outcomes.

## 20.4 CI/CD Conventions

As projects mature, shared workflows may be introduced.

However, each project must retain a clearly understandable implementation of the engineering mechanisms it demonstrates.

Avoid abstracting away the most important parts of a project solely for code reuse.

## 20.5 Reproducibility

Every project should document:

- Required versions.
- External dependencies.
- Environment variables.
- Secrets configuration.
- Setup procedures.
- Build procedures.
- Test commands.
- Scenario execution.
- Expected behavior.
- Cleanup.

---

# 21. Open Architectural Decisions

The overall portfolio strategy is established, but several implementation-level choices remain open.

These should be resolved during project-specific design rather than silently treated as finalized.

**Resolved for Project 1** (recorded in its DECISIONS.md):

1. Go version: `go 1.26.0` minimum in `go.mod` (raised from 1.25.1 for OpenTelemetry in Milestone 15).
2. HTTP router: chi.
3. Database access: pgx with sqlc-generated queries and goose migrations.
4. Authentication: short-lived JWT access tokens with server-tracked rotating refresh sessions in HttpOnly cookies; guest sessions for guest checkout.
5. React architecture: feature folders, React context and hooks, native `fetch`; no state or data-fetching library.
6. UI components: Tailwind CSS with project-owned shadcn components.
7. Database schema and business rules: 21 tables (§5.5); the migrations are authoritative.
8. Serving: one origin; the Go API serves the built frontend over HTTPS.
9. Observability split: instrumentation in the application, the stack in Project 4 (§5.6, §15.5).

**Still open:**

1. Local messaging implementation (Project 7).
2. AWS account/environment organization.
3. Terraform module boundaries.
4. Kubernetes deployment approach per environment.
5. Artifact release and promotion process beyond `v1.0.0`.
6. Performance targets.
7. RTO/RPO targets.
8. Automated infrastructure teardown policies.
9. Ownership and versioning of shared API contracts.
10. Where the cloud deployment with a CDN-hosted frontend and a load-balanced API belongs (currently drafted as Project 1 milestone M17; candidates are Project 2 or a later infrastructure project).
11. Whether scenario environments run the image in production mode (TLS, SMTP, verified database TLS) or local mode.
12. Whether Project 7 is developed in the Project 1 repository or a fork of it.

Preferred starting points have been described in this document.

However, preferences are not equivalent to fully approved implementation designs.

These decisions should be made deliberately, documented, and validated against requirements.

---

# 22. Instructions for a Fresh ChatGPT Session

When this document is provided to a new ChatGPT conversation, the assistant should:

1. Read the entire document as background context.
2. Understand the portfolio's employment-focused purpose.
3. Preserve the seven-project structure (Project 1, scenario Projects 2–6, Project 7) unless explicitly asked to revise it.
4. Preserve Go as the primary backend language.
5. Preserve React, TypeScript, and Vite as the frontend stack.
6. Preserve the independent repository strategy.
7. Preserve the shared, versioned order-processing application architecture.
8. Respect the documentation standards.
9. Prioritize realistic engineering challenges.
10. Avoid unnecessary technical complexity.
11. Distinguish approved decisions from recommendations and unresolved questions.
12. Maintain consistency between portfolio-level and project-level decisions.
13. Help produce professional engineering documentation before substantial implementation.
14. Avoid claiming projects have been implemented or tested without evidence.
15. Apply the scenario rule (§2.4): scenario fixes never change application code.

The assistant should act as a knowledgeable senior software engineer, DevOps engineer, system architect, and technical reviewer.

The assistant should explain important tradeoffs, challenge weak assumptions, and prioritize engineering correctness.

It should not reflexively agree with every proposed design.

---

# 23. Instructions for Codex

When this document is provided to Codex, use it as the high-level context for the portfolio.

Before making repository changes:

1. Identify the active project.
2. Inspect its existing code and documentation.
3. Review applicable repository instructions.
4. Identify the current milestone.
5. Determine which requirements apply.
6. Identify relevant architecture decisions.
7. Determine the expected tests and verification procedures.

While implementing:

- Follow the project's approved design.
- Prefer small, reviewable changes.
- Do not introduce unnecessary dependencies.
- Do not silently redesign system architecture.
- Do not remove safety or testing controls for convenience.
- Keep Go code idiomatic.
- Keep React and TypeScript code appropriately typed.
- Preserve compatibility with documented contracts.
- Update documentation when behavior changes.
- Verify results where execution is available.

After implementation, report:

- Files modified.
- Requirements addressed.
- Architectural changes.
- Tests executed.
- Test results.
- Known limitations.
- Outstanding work.

Do not claim that a command, deployment, test, or recovery procedure succeeded unless it actually did.

Never deploy infrastructure, incur cloud charges, delete persistent resources, or execute destructive failure scenarios without the necessary user authorization.

---

# 24. Current Portfolio State

**As of revision 1.1 (2026-11-08):**

- The portfolio concept has been selected.
- Seven engineering projects have been proposed and scoped at a high level.
- The shared fictional commerce environment has been selected.
- Go has been selected as the backend language.
- React, TypeScript, and Vite have been selected for the frontend.
- PostgreSQL is the primary database.
- AWS is the preferred cloud provider.
- Separate repositories are the preferred organization.
- The order-processing application will provide reusable, versioned artifacts.
- A comprehensive documentation framework has been established.
- AI-assisted implementation is in use.
- **Project 1 is in implementation.** Milestones M1–M14 are complete and verified; the repository's STATUS.md records the evidence.
- **Projects 2–7 have not started.** No infrastructure has been provisioned.

This document records strategy. Implementation status and test evidence live in each project's status and results documents.

---

# 25. Recommended Next Steps

Steps 1–3 are under way: the foundation documents exist, and Project 1 is implemented through M14.

## Step 1 — Portfolio Foundation

Establish:

- GitHub repository naming conventions.
- Shared documentation standards.
- Root portfolio overview.
- AGENTS.md conventions.
- Versioning conventions.
- Project status conventions.

## Step 2 — Project 1 Documentation

Draft and review:

1. PROJECT_BRIEF.md
2. PRD.md
3. ARCHITECTURE.md
4. TECHNICAL_DESIGN.md
5. DATABASE_SCHEMA.md
6. CONCURRENCY_DESIGN.md
7. OBSERVABILITY_CONTRACT.md
8. OpenAPI specification
9. IMPLEMENTATION_PLAN.md
10. TEST_PLAN.md

Other supporting documents may begin as concise drafts and mature during implementation.

## Step 3 — Project 1 Implementation

Develop the foundational Go and React application through small, testable milestones. 
Finish with the built-in observability instrumentation (M15) and a configurable database pool size (§5.6).

## Step 4 — Publish a Stable Application Release

Produce the `v1.0.0` container image (M16), publish it to GitHub Container Registry, record its digest, and document the release process. 
Map Project 1's documents to the standard set (§13).

## Step 5 — Begin Project 2

Create the CI/CD recovery repository using pinned artifacts from Project 1.

Continue through the remaining projects in the agreed sequence.

---

# 26. Final Engineering Principles

The following principles should guide every project.

**1. Engineering depth over project count.**

A small number of rigorous projects is more valuable than many shallow demonstrations.

**2. Realistic problems over artificial tool demonstrations.**

Start with an engineering problem and select tools to solve it.

**3. Requirements before implementation.**

Define what correctness means before building the solution.

**4. Architecture with justification.**

Major design choices should have documented reasoning.

**5. Testing is part of development.**

Tests are not an optional final activity.

**6. Reliability must be demonstrated.**

Use reproducible failures and recovery procedures.

**7. Security should be built in.**

Use least privilege, secure defaults, and continuous verification.

**8. Results must be real.**

Never fabricate performance, recovery, reliability, or security evidence.

**9. Infrastructure must be reproducible.**

Prefer version-controlled, automated provisioning.

**10. AI assistance does not replace understanding.**

The portfolio creator must understand and be able to defend important implementation decisions.

**11. Documentation should be accurate and useful.**

Documentation should guide implementation and support reviewers, not exist merely as decoration.

**12. The portfolio should tell a coherent story.**

The seven projects should collectively demonstrate the lifecycle of developing, delivering, operating, securing, recovering, optimizing, and automating a real software system.

---

# End of Master Context

This document should be updated when major portfolio-level decisions change.

Project-specific requirements and implementation details should remain in their respective repositories rather than being duplicated throughout this document.

