# Milestone 17: CDN frontend and load-balanced API

**Goal:** run the application in its target production shape. The built SPA is served from a CDN (S3 + CloudFront), and the Go API runs as several tasks behind an AWS Application Load Balancer (ALB). The browser still sees one HTTPS origin.

**State:** in progress (task 1, the decisions below, done 2026-11-12). It follows the tagged baseline from [Milestone 16](MILESTONE_16.md). Task breakdown: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md#milestone-17--cdn-frontend-and-load-balanced-api).

## Why a separate milestone

M14 to M16 deliberately build a single-host baseline:
- TLS ends in the Go process.
- There is no reverse proxy.
- One API instance serves both `dist/` and `/api`.
- One image is run by Compose.

That baseline is the image Projects 2–6 run, pinned by digest. It stays valid and tagged.

Moving to a CDN and a load balancer changes assumptions the application currently relies on:
- **Client IP:** rate limits key on the TCP peer address (`RemoteAddr`). Behind CloudFront and an ALB, that address is the proxy's.
- **Limit state:** rate limits live in process memory. With several tasks, each task keeps its own counts, and every deploy resets them.
- **TLS:** production mode requires `TLS_CERT_FILE`, but TLS normally ends at CloudFront and the ALB.
- **Static files:** the static file rules (caching, the SPA fallback, HTML security headers) live in Go. They must move to S3 object metadata and CloudFront.

These are application changes, not just packaging. That is why they come after the baseline, rather than being folded into M16.

## Target architecture

```text
Browser ──HTTPS──▶ CloudFront  (one origin, e.g. https://shop.example.com)
                     ├── default behavior  ──▶ S3 bucket (private, Origin Access Control): dist/
                     └── /api/*            ──▶ ALB (HTTPS) ──▶ API tasks (ECS, 2 or more)
                                                                  │
                                                                  ▼
                                                        RDS PostgreSQL 16 (verify-full)
```

What stays the same as the M14–M16 design:

- **One origin:**
  - The same-origin build (`npm run build:same-origin`, API base `/api/v1`) is used unchanged.
  - Cookies stay host-only, `__Secure-`, `SameSite=Strict` and path-scoped.
  - The CSRF check still compares the browser's `Origin` header with one `FRONTEND_ORIGIN`.
  - No CORS is needed in production.
- **Email links** use `FRONTEND_ORIGIN`, which becomes the CloudFront domain.
- **Health:** `/health/ready` gates traffic. The ALB health check calls it directly on each task. `/health/*` and `/metrics` are not routed through CloudFront.

## Required application changes

| Area | Today | M17 change |
|---|---|---|
| Client IP for rate limits | `RemoteAddr` in `auth.allowPeer` and in the guest admission and bootstrap limits | One helper that derives the client IP only from proxy headers the deployment trusts (CloudFront's `CloudFront-Viewer-Address`, or a fixed number of trusted `X-Forwarded-For` hops). Local mode keeps `RemoteAddr`. Spoofed headers must have no effect. |
| Rate-limit state | In-memory `auth.RequestLimiter` and `limiter`, per process | Shared counters, so limits hold across tasks and deploys. Concurrency slots (for example the 32 guest write slots) can stay per task, because they protect each process. |
| TLS | Production requires `TLS_CERT_FILE` and `TLS_KEY_FILE` | **No change.** The ALB re-encrypts to the tasks, which keep TLS in Go with an internal self-signed certificate (the ALB does not verify target certificates). Secure cookies stay on. |
| HSTS and HTML headers | Set by Go (`HSTS` when production and TLS; `Static` adds the HTML headers) | Set by a CloudFront response headers policy. The Go rules stay for the single-host mode. |
| Static serving | `STATIC_DIR` in the API | Not used in this mode. S3 holds `dist/`, and CloudFront applies the caching and fallback rules. `STATIC_DIR` stays optional for the single-host mode. |
| Process-local state | Assumed single instance | Audit all of it (limiters, slots, counters, anything cached) and record which items must be shared. |

## CDN rules (carried over from the M14 static rules)

- **SPA fallback:** a CloudFront Function on the default (S3) behavior rewrites extensionless page paths to `/index.html`. Do **not** use distribution-wide custom error responses. Those would also rewrite API 404s into HTML.
- **Caching:**
  - `assets/*`: `public, max-age=31536000, immutable`
  - `fixtures/v1/*`: `public, max-age=3600`
  - `index.html` and everything else: `no-cache`

  These values are set as S3 object metadata at upload time.
- **`/api/*` behavior:**
  - caching disabled
  - all methods allowed
  - viewer `Origin`, `Cookie`, CSRF and idempotency headers and the query string forwarded
  - `Set-Cookie` passed back unchanged
- **Security headers:**
  - on every response: `X-Content-Type-Options: nosniff`, and HSTS (`max-age=31536000`)
  - on HTML: `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`
- **Publish order:**
  1. Upload new hashed assets.
  2. Upload `index.html` last.
  3. Keep the previous release's assets for at least one release, so tabs that are already open don't break.
- **Locked-down origins:** the ALB accepts traffic only from CloudFront, through the AWS-managed CloudFront prefix list plus a secret origin header. The S3 bucket is reachable only through Origin Access Control.

## Decisions (task 1, 2026-11-12)

| Topic | Decision | Why |
|---|---|---|
| Infrastructure as code | **Terraform**, AWS only | The owner's tool. Every resource is reproducible and destroyable. |
| Layout | One **development** root module, `infrastructure/terraform/environments/development`, built from one module per layer (`network`, `ecs-cluster`, `database`, `service`, `edge`) | A reviewer runs one `terraform apply`. The layers mirror the owner's separate tf-* repositories, so production can split them into separate roots with remote state. |
| State | Local by default; `backend.s3.tf.example` switches to an S3 bucket with `use_lockfile` | A reviewer needs no state bucket. State holds generated secrets, so it is never committed. |
| Container platform | **ECS on an EC2 capacity provider** (Auto Scaling group, ECS-optimized AMI, managed scaling), `awsvpc`, IP target groups, 2 API tasks | Matches the owner's ECS pattern; instances also give SSM access for port forwarding. |
| Domain | **Optional** `domain_name`. Set: Route 53 records, ACM certificates (us-east-1 for CloudFront, regional for the ALB), HTTPS from CloudFront to the ALB. Unset: the `*.cloudfront.net` address and HTTP from CloudFront to the ALB. The hosted zone lives outside this stack. | Works for a reviewer without a domain; the owner's domain gives HTTPS on every hop and a stable origin. |
| Origin lockdown | ALB security group allows only the CloudFront origin-facing managed prefix list; the listener returns 403 unless a secret origin header matches | Direct requests to the ALB are refused in both domain modes. |
| ALB to task TLS | **Re-encrypt.** Tasks keep TLS in Go with a Terraform-generated self-signed certificate | No application change; the production rule that requires TLS stays. |
| Client IP source | `CloudFront-Viewer-Address`, trusted only with `TRUSTED_PROXY=cloudfront` | One header set by CloudFront, no hop counting. Without the setting, `RemoteAddr` is used as today. |
| Shared rate-limit store | **PostgreSQL** (migration 14) | No new service. |
| Migrations | Each task runs `db-bootstrap` (idempotent roles, certificates) and `migrate up` as init containers before `api` starts (`dependsOn` success); the migration advisory lock makes concurrent tasks safe | A new task never takes traffic on an older schema, with one `apply` and no pipeline. Production would run a separate one-off task. |
| Database | RDS PostgreSQL 16, single-AZ for development, `rds.force_ssl`, `verify-full` with the regional RDS CA bundle | Matches the existing production database rule. |
| Secrets | Generated by Terraform, stored in Secrets Manager, injected through the task definition | No secret in images, tfvars or the repository. |
| Mail | Mailpit as an ECS service (Cloud Map DNS, STARTTLS with a Terraform-issued certificate); its UI through SSM port forwarding | Production mode requires SMTP; no mail leaves AWS. |
| Image and frontend | Terraform builds the image and pushes it to ECR (pinned by digest), extracts `/app/dist` from it, and publishes it to S3 (assets, then fixtures, then `index.html`; previous assets kept) | One `apply`; the frontend is exactly the one in the image. Needs Terraform, Docker and the AWS CLI only. |
| Telemetry | Off on AWS for now; the M15 instrumentation is unchanged | An ADOT Collector is a later option. |
| CI/CD | None yet; the repository stays local | GitHub Actions with OIDC later, as in the owner's tf-* repositories. |

### Process-local state audit

| State | Where | M17 |
|---|---|---|
| 15 named request limiters (`auth_ip`, `auth_email`, `security_ip`, `security_user`, `security_token`, seven `guest_*`, three `guest_checkout_*`) | `auth/http.go`, `commerce/guest_http.go`, `checkout/guest_http.go` | **Shared** (task 3) |
| Concurrency slots: 32 guest writes, 32 password resets, 2 password hashes, 2 SMTP sends | `commerce/guest_http.go`, `auth/http.go`, `auth/password.go`, `email/smtp.go` | Per task (they protect each process) |
| Metrics | OpenTelemetry meter in each process | Per task; scraped per task when enabled |

## Release gates

1. **Regression.** All M1–M16 behavior still passes, including the single-host mode and the full browser suite.
2. **Client IP.** Limits apply per real viewer. A forged `X-Forwarded-For` or viewer-address header from a client changes nothing, and direct requests to the ALB are refused.
3. **Shared limits.** A limit (for example the 5-per-hour guest bootstrap) holds across two or more tasks and across a rolling deploy.
4. **CDN behavior.**
   - Deep links and reloads work for every route family and email-link page.
   - Unknown `/api` paths return JSON 404.
   - Caching and security headers match the CDN rules above.
   - `/metrics` is not publicly reachable.
5. **Browser journeys.** The HTTPS browser group (M14 task 8) passes against the CloudFront URL: sign-in and refresh, guest cart and checkout, both payment scenarios, orders, email links.
6. **Resilience.**
   - Stopping one task during traffic causes no failed requests beyond the documented retry behavior.
   - A rolling deploy keeps old browser tabs working.
   - Migrations run before new tasks receive traffic.
   - The recovery CLI runs as a one-off task.
7. **Evidence and teardown.** Record the infrastructure version, image digest, distribution and service identifiers (no secrets), and test results. A documented teardown removes every resource.

## Out of scope

Multiple regions, autoscaling policies beyond a fixed task count, a web application firewall (WAF) rule set, a CSP beyond the current headers, blue/green tooling beyond ECS rolling updates, and background workers or queues (still reserved for Project 7).
