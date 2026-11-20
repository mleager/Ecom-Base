# Mentorship

__Purpose__: Build a portfolio of reproducible, production-inspired engineering projects demonstrating backend software development, DevOps, reliability, security, incident response, and infrastructure automation.

__Focus:__ Demonstrate engineering judgment, not just tool familiarity

__Documentation:__ [`docs/updated/PORTFOLIO_MASTER_CONTEXT.md`](docs/updated/PORTFOLIO_MASTER_CONTEXT.md) is the source of truth for the strategy, each project's scope and the open decisions. This README is the short version.


These are the main topics the Portfolio Projects will cover:

- __Architecture:__ Knowing why a particular solution is appropriate.

- __Reliability:__ Designing systems that withstand failures.

- __Security:__ Protecting infrastructure, applications, credentials, and data.

- __Incident response:__ Diagnosing failures and restoring service.

- __Automation:__ Reducing human error and repetitive operations.

- __Software Engineering:__ Writing maintainable application and automation code, not just configurations.


## Portfolio Projects

Seven inter-connected projects around one e-commerce application (the fictional company "Commerce Reliability Lab"):

- __Project 1__ builds the application.
- __Projects 2–6__ are scenarios that operate it.
- __Project 7__ evolves the application into an event-driven version.


1. __E-Commerce App / Reliable Order Processing__ (`01-order-processing`)

- Build the store: accounts, catalog, cart, guest and account checkout with a simulated payment, orders, admin, and a recovery CLI for interrupted orders
- Prove no overselling, idempotent checkout, exactly-once settlement and crash recovery with automated tests
- Ship built-in observability: OpenTelemetry traces and metrics, and logs linked to traces (off until configured)
- Release `v1.0.0` (tag `base-v1.0.0`, image `ghcr.io/mleager/ecom-base:1.0.0`): one container image (API + frontend, one HTTPS origin), published to GHCR and pinned by digest
- Go, PostgreSQL, React, TypeScript, Vite, Playwright, OpenTelemetry

2. __CI/CD Recovery and Progressive Deployment__ (`02-cicd-recovery`)

- Deploy a faulty release, detect elevated errors from the app's metrics, stop the rollout, and roll back with minimal customer impact
- Show why some rollbacks are unsafe (schema changes) and fix that with expand-and-contract migrations
- GitHub Actions, Docker, GHCR, Kubernetes, Helm, Argo CD, Argo Rollouts, Prometheus

3. __Secure Database and Disaster Recovery__ (`03-database-recovery`)

- Simulate accidental table deletion, data corruption and a failed migration, then demonstrate
secure, tested recovery without unnecessarily losing legitimate transactions
- Measure RTO and RPO
- PostgreSQL, AWS RDS (point-in-time recovery), Terraform, Secrets Manager, Go validation tools

4. __Performance Engineering and Production Outages__ (`04-performance-engineering`)

- Run the observability stack (dashboards, alerts, SLOs) on the app's built-in telemetry
- Simulate a traffic surge, slow dependencies and connection exhaustion; find the bottlenecks, fix them operationally, and prove the improvement with before-and-after load tests
- OpenTelemetry Collector, Prometheus, Grafana, Tempo, Loki, k6, PostgreSQL

5. __Cloud Security Audit and Remediation__ (`05-cloud-security`)

- Start with deliberately insecure infrastructure in an isolated lab. Identify the attack paths,
eliminate exposure, rotate credentials, and implement automated protections
- AWS IAM, VPC, Terraform, Trivy, Checkov, Secrets Manager, GitHub OIDC

6. __Internal Developer Platform__ (`06-developer-platform`)

- Build a Go CLI that lets developers create a service with infrastructure, CI/CD,
observability, security checks, and environment configuration without manual operations
- Go, Terraform, GitHub Actions, Kubernetes; Backstage optional

7. __Asynchronous Order Processing__ (`07-async-order-processing`)

- Evolve Project 1 into `v2.0.0`: a payment provider, transactional outbox, message queues and workers
- Demonstrate retries, idempotency, dead-letter queues, and recovery when events are delayed, duplicated or lost
- Go, PostgreSQL, AWS SQS

## The Scenario Rule

Projects 2–6 never change the application's code:

- They run a released, versioned image of Project 1 that already includes the observability and metrics needed to diagnose problems.
- Faults come from infrastructure or configuration. When a fault must live inside the app, it comes from a prebuilt "fault-variant" image.
- Fixes are operational: configuration, deployment and rollback, database administration, scaling, access control and runbooks.
- If the real long-term fix is a code change, it's recorded as a recommendation for a later Project 1 release.

Project 7 is the exception: it is a new version of the application, not a scenario.

## Designing the Projects

Each project should tell an `engineering story`: a business requirement, a failure or limitation,
my investigation, the solution, and evidence that it works

The projects share one engineering environment and one application, instead of deploying unrelated apps

## Packaging Each Project

Each project should include:

1. __Architectural Design__

- shows infra, components, networking, trust boundaries, and data flows

2. __Problem Statement__

- describe the fictional company's requirements or incident and why it matters

3. __Infrastructure and Code__

- provide reproducible configurations, scripts, and tests (scenario projects pin the application image by digest instead of copying its code)

4. __Failure Demonstration__

- show exactly how the incident was reproduced and detected

5. __Recovery or Remediation__

- explain the implementation, engineering trade-offs, and alternates that were considered

6. __Measured Results__

- include actual logs, test results, recovery times, latency measurements, or other evidence

7. __Postmortem / Technical Write-Up__

- document root cause, impact, correct actions, and lessons learned

8. __Runbook (optional)__

- supplement the Postmortem / technical write-up for other developers if the problem occurs again


## Github Repository Organization

One repository per project, plus a landing page that ties them together:

| Repository | Contents |
|---|---|
| `01-order-processing` | Application source (Go API, React frontend, migrations, tests); release images on GHCR; fault-variant branches and tags |
| `02-cicd-recovery` | Pipelines, Helm charts, Argo CD and Argo Rollouts configuration |
| `03-database-recovery` | Terraform for RDS, backup and restore automation, validation tools |
| `04-performance-engineering` | Observability stack, dashboards, alerts, SLOs, k6 load tests |
| `05-cloud-security` | Insecure-lab and remediated Terraform, scanners, CI security gates |
| `06-developer-platform` | Go CLI, service templates, tests |
| `07-async-order-processing` | The event-driven application version (`v2.0.0`). Still open: this repository, or a branch line in `01-order-processing`. |
| `portfolio` | Landing page: architecture, project summaries, case studies, demos |
