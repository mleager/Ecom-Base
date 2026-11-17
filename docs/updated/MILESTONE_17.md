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
- **Locked-down origins:** the ALB is internal and accepts traffic only from this account's CloudFront distributions, through a CloudFront VPC origin (task 5 verified the earlier design: a public ALB, the CloudFront prefix list and a secret origin header; see "After verification"). The S3 bucket is reachable only through Origin Access Control.

## Decisions (task 1, 2026-11-12)

| Topic | Decision | Why |
|---|---|---|
| Infrastructure as code | **Terraform**, AWS only | The owner's tool. Every resource is reproducible and destroyable. |
| Layout | One **development** root module, `infrastructure/terraform/environments/development`, built from one module per layer (`network`, `ecs-cluster`, `database`, `service`, `edge`) | A reviewer runs one `terraform apply`. The layers mirror the owner's separate tf-* repositories, so production can split them into separate roots with remote state. |
| State | Local by default; `backend.s3.tf.example` switches to an S3 bucket with `use_lockfile` | A reviewer needs no state bucket. State holds generated secrets, so it is never committed. |
| Container platform | **ECS on an EC2 capacity provider** (Auto Scaling group, ECS-optimized AMI, managed scaling), `awsvpc`, IP target groups, 2 API tasks | Matches the owner's ECS pattern; instances also give SSM access for port forwarding. |
| Domain | **Optional** `domain_name`. Set: Route 53 records, ACM certificates (us-east-1 for CloudFront, regional for the ALB), HTTPS from CloudFront to the ALB. Unset: the `*.cloudfront.net` address and HTTP from CloudFront to the ALB. The hosted zone lives outside this stack. | Works for a reviewer without a domain; the owner's domain gives HTTPS on every hop and a stable origin. |
| Origin lockdown | Internal ALB behind a CloudFront VPC origin; its security group admits only `CloudFront-VPCOrigins-Service-SG` (this account's distributions) | Nothing outside CloudFront can reach the ALB, in both domain modes, with no shared secret to leak or rotate. |
| ALB to task TLS | **Re-encrypt.** Tasks keep TLS in Go with a Terraform-generated self-signed certificate | No application change; the production rule that requires TLS stays. |
| Client IP source | `CloudFront-Viewer-Address`, trusted only with `TRUSTED_PROXY=cloudfront` | One header set by CloudFront, no hop counting. Without the setting, `RemoteAddr` is used as today. |
| Shared rate-limit store | **PostgreSQL** (migration 14, `RATE_LIMIT_STORE=postgres`; memory stays the default) | No new service. |
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
| 19 named request limiters (`auth_ip`, `auth_ip_site`, `auth_email`, `auth_email_client`, `security_ip`, `security_user`, `security_token`, `password_reset_address`, eight `guest_*`, three `guest_checkout_*`; the two `_site` limiters since task 6, `auth_email_client` since task 7) | `auth/http.go`, `commerce/guest_http.go`, `checkout/guest_http.go` | **Shared** with `RATE_LIMIT_STORE=postgres` (task 3, done) |
| Concurrency slots: 32 guest writes, 32 password resets, 2 password hashes, 2 SMTP sends | `commerce/guest_http.go`, `auth/http.go`, `auth/password.go`, `email/smtp.go` | Per task (they protect each process) |
| Metrics | OpenTelemetry meter in each process | Per task; scraped per task when enabled |

## AWS verification (task 5, 2026-11-15)

Run against the Terraform development stack in `us-east-1` (Terraform 1.12.2, AWS provider 6.70.0), first with `domain_name = "zerodawndevops.com"` (`https://shop.zerodawndevops.com`), then with no domain (`https://d3itvf8x0oggja.cloudfront.net`), then back. Image `ecom-development@sha256:d0938675bc536b45ae709c1ad6798b190b7fac4b4921226e9c6fd04cc7bc9f53`, distribution `E3NA9IBLCR5ATE`, cluster `ecom-development`.

| Gate | Check | Result |
|---|---|---|
| 2 | 26 sign-ins with forged `X-Forwarded-For`, `X-Real-IP` and `CloudFront-Viewer-Address` | All keyed on the real viewer IP: 429 after the 20-per-minute budget. Same in no-domain mode (guest bootstrap). |
| 2 | Direct requests to the ALB DNS name and `origin.zerodawndevops.com` | Time out (security group admits only CloudFront). |
| 3 | 30 sign-ins on a fresh window, 2 healthy targets | Exactly 20 admitted, then 429. Per-task counters would admit about 40. |
| 3 | Guest bootstrap exhausted (5 per hour), then a forced rolling deploy replaced both tasks | Still 429 from the new tasks. |
| 4 | Deep links (`/`, `/products`, `/cart`, `/orders/…`, `/account/security`, `/verify-email`, `/guest/orders/…`, `/password-reset`) | 200 `index.html`, `no-cache`. |
| 4 | Caching and headers | Assets `public, max-age=31536000, immutable`; `fixtures/v1` `max-age=3600`; HSTS and `nosniff` everywhere; `X-Frame-Options` and `Referrer-Policy` on static responses. |
| 4 | `/api/v1/nope`, `/metrics`, `/.env`, source maps, `bundle.json` | JSON 404; `/metrics` gets only the SPA page; the rest 403 from S3. |
| 5 | Deployment browser journey (`playwright.deploy.config.ts`) with Mailpit through SSM port forwarding | Both journeys pass in both domain modes: account sign-in, emailed verification link, accepted checkout; guest accepted and rejected checkout, receipts, emailed order link. The M14 HTTPS group starts its own API per test, so it cannot target CloudFront; this journey is its deployed equivalent. |
| 6 | One task stopped, then a forced rolling deploy, under about 8 requests per second | 3,996 of 3,996 requests returned 200. |
| 6 | Migrations before traffic | Each task logged `db-bootstrap`, then `migrate` (exit 0, schema 14), then `api`; both first tasks migrated concurrently under the advisory lock. |
| 6 | Recovery CLI | `reconcile --dry-run` ran as a one-off ECS task (0 visited, 0 failed). |
| — | Drift | A plan after the final apply reports no changes. |

Not covered: an old browser tab across a deploy that changes the frontend (the rolling deploy reused the same image; the publish step keeps previous assets by design).

### Defects found and fixed

1. **Bearer tokens were not forwarded.** The `/api/*` origin request policy listed headers, and CloudFront never forwards `Authorization` from a list: every signed-in request got 401. The policy now forwards all viewer headers plus `CloudFront-Viewer-Address`. That includes `Host`, so the ALB certificate also covers `shop.<domain>`.
2. **Services could start before the execution role could read secrets.** The first Mailpit launches failed with `AccessDenied` until ECS retried. Both services now depend on the policy.
3. **Perpetual drift on the RDS parameter group.** RDS stores both parameters as `pending-reboot`; the configuration now says so.
4. **The ALB listener could not switch from HTTPS to HTTP in place.** A protocol change now replaces it (`replace_triggered_by`).

### Teardown (2026-11-15)

`terraform destroy` needed three runs and a manual cleanup, and found two more ordering defects:

5. **The NAT gateway was destroyed while ECS still ran in the private subnets.** The ECS agents lost their route to the ECS API, stopped tasks' network interfaces stayed attached, and both services hung in `DRAINING` past Terraform's 20-minute timeout. Recovered by scaling the Auto Scaling group to 0, force-deregistering the container instances and completing the ECS draining lifecycle hook. Fixed: the network module's `private_subnet_ids` output depends on the NAT gateway and private routes, so everything placed in those subnets is destroyed first.
6. **The internet gateway could not detach while the ALB's public addresses existed.** Fixed: `public_subnet_ids` depends on the gateway and public routes, so the ALB is destroyed first.

Final state: Terraform state empty; no VPC, NAT gateway, load balancer, RDS instance, distribution, ECR repository, bucket, secret or certificate left; the cluster and task definitions are `INACTIVE` (no cost); the hosted zone holds only its NS and SOA records. Fix 5 held in the 2026-11-16 teardown below; fix 6 no longer applies once the ALB is internal (see defect 7).

### After verification: CloudFront VPC origin (2026-11-16)

From the DevOps review of the verified stack. The prefix list admits every CloudFront distribution, so the stack needed a shared `X-Origin-Verify` secret to tell its own apart; the secret sat in state and in the distribution's configuration and had no rotation path. Now:

- The ALB is **internal**, in the private subnets. CloudFront reaches it through `aws_cloudfront_vpc_origin`, with the same protocol per domain mode (HTTPS with a domain, HTTP without).
- The ALB security group admits only `CloudFront-VPCOrigins-Service-SG`, the AWS-managed group for this account's distributions. The listener forwards by default; the header rule, the secret and the `ORIGIN_VERIFY` key are gone.
- The network skips AZ IDs without VPC origin support (`use1-az3` in us-east-1).
- Cost falls by the ALB's two public IPv4 addresses, about $7.30 a month; VPC origins have no charge of their own.

Verified on AWS on 2026-11-16 (same image digest as task 5; distribution `E1IURJFCRIVDWI`), first with the domain, then switched to no-domain mode, then destroyed:

| Gate | Check | Result |
|---|---|---|
| 2 | ALB scheme and addresses | `internal`; no public IPv4 on its interfaces; the ALB name and `origin.zerodawndevops.com` resolve to `10.40.11.x`. Direct requests from the internet time out. |
| 2 | ALB security group | One ingress rule: the listener port from `CloudFront-VPCOrigins-Service-SG`. |
| 2 | 26 sign-ins, each with a different forged `X-Forwarded-For`, `X-Real-IP` and `CloudFront-Viewer-Address` | Exactly 20 admitted (401), then 429: keyed on the real viewer IP. |
| 2 | No-domain mode, guest bootstrap with forged headers | 3 × 201, then 429 (2 of the 5 per hour already used by the journey). |
| 5 | Deployment browser journey | Both journeys pass in both domain modes (HTTPS and HTTP to the VPC origin). |
| 6 | Recovery CLI | `reconcile --dry-run` ran as a one-off task (all containers exit 0). |
| — | Domain-mode switch | The new VPC origin (`…-api-http`) was created before the old one was removed; the listener was replaced. CloudFront again held the `shop.` certificate briefly ("in use"); it was removed by the destroy. |

The first apply failed on one rule: EC2 rejects an apostrophe in a security group rule description. Fixed in the description.

#### Teardown: two more ordering defects

The first `terraform destroy` hung for 20 minutes with the API service in `DRAINING`, although the NAT gateway was still there (fix 5 held). All three ECS agents were disconnected:

7. **The public route table was destroyed early.** Fix 6 protected it only through the public ALB's subnets; with an internal ALB nothing referenced it, so the NAT gateway lost its route to the internet. Fixed: the NAT gateway depends on the public route associations, so everything behind it is destroyed first.
8. **The container instances' egress rule and ECS IAM policy attachment were destroyed early.** Nothing referenced them. Fixed: the Auto Scaling group depends on both IAM attachments and the egress rule, so they outlive the instances (this also orders them before instance registration on create).

Recovered by re-creating those six resources with a targeted apply; the agents reconnected and the second destroy removed the remaining 75 resources in 15 minutes, with no `DependencyViolation` from the VPC origin's interfaces. Final state: Terraform state empty; no VPC, NAT gateway, Elastic IP, load balancer, VPC origin, RDS instance, distribution or certificate left. Fixes 7 and 8 pass `fmt` and `validate` and ran in that second destroy, but not yet in a destroy from a full stack.


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


### After verification: ECS task split (2026-11-16)

From the DevOps review (findings 2.1–2.5). Each API task used to run `db-bootstrap` with the RDS master password, download the RDS CA bundle and run `migrate up` before `api`.

- **One-off tasks.** `db-bootstrap` and `migrate` have their own task definitions and execution roles, and Terraform runs them with `modules/service/files/run-task.sh` before the API service is updated. The API task keeps only a `certs` init container. `run_one_off_tasks = false` leaves the jobs to a pipeline.
- **`db-bootstrap` in Go** (`backend/cmd/db-bootstrap`), replacing the shell script. Integration test: three concurrent runs and one more on a fresh database, the resulting owners and privileges, then `migrate up` and runtime readiness.
- **RDS-managed master password**, read only by the bootstrap task. Secrets are split by reader: `database/migrator`, `database/app`, `api`, `mail`.
- **The RDS global CA bundle is in the image**, pinned by checksum. The API tasks' egress is limited to PostgreSQL and Mailpit.
- **Rule:** migrations must work with the previous release's code, because they now run before the rollout.

Local checks (2026-11-17): `dev.sh check`, `integration --race` (including `TestDBBootstrap`), the image build (`db-bootstrap` present, CA bundle matches the pinned checksum, mode 0444) and `deploy-verify` all pass. `deploy-verify` had expected exactly 13 migrations since M16 and failed after migration 14 (task 3); it now counts the migrations in `backend/migrations`.

AWS checks (2026-11-17, domain mode, us-east-1). Two defects were found and fixed first:

1. `ADD --chmod=0444` also created `/etc/ssl/rds/` as 0444, which the runtime user (65532) cannot enter. pgx then failed to read `sslrootcert`, and `db-bootstrap` exited with "invalid PostgreSQL connection configuration". The bundle is now fetched in the build stage, given modes 0755 (directory) and 0444 (file), and copied into the image. `release-evidence.sh` now runs `db-bootstrap` as the runtime user against a closed port and requires a connection error rather than a configuration error.
2. `run-task.sh` printed no container output. The `describe-log-streams` query found nothing, so the script now derives each stream name (`<prefix>/<container>/<task id>`) from the task definition's log options.

Also added: `run-task.sh` retries "unable to assume the role" while a new execution role propagates in IAM.

| Check | Result |
|---|---|
| Fresh apply | `db-bootstrap` created `ecom_migrator` and `ecom_app` (exit 0). `migrate` applied 1–14 (exit 0). The API service reached steady state with 2 tasks: `certs` exited 0 and `api` is running. The site, `/api/v1/products` and `/health/ready` return 200. A second plan shows no changes. |
| Least privilege | Each task family has its own execution role. Secrets reach only their readers: `certs` gets `API_TLS_KEY`; `api` gets `DATABASE_URL` (app role), `JWT_SECRET_BASE64` and `SMTP_PASSWORD`; `migrate` gets `DATABASE_URL` (migrator role); `db-bootstrap` gets the master, migrator and app passwords. The API security group's egress allows only 5432 and 1025. |
| Image change with one new migration (temporary seed, not committed) | Only `migrate` ran (applied 15). `db-bootstrap` did not run again. The API then rolled out, and 374 of 374 requests to `/api/v1/products` (one a second) returned 200 during the apply and rollout. |
| Gate 2 | Guest bootstrap with forged `CloudFront-Viewer-Address` and `X-Forwarded-For`: 4 × 201, then 429. The journey had used 1 of the 5 per hour. |
| Deployment browser journey | Both journeys pass on the new image, with Mailpit through SSM port forwarding. |
| Failing migration (`SELECT 1 / 0`, temporary) | `migrate` exited 1 with `SQLSTATE 22012` and printed its log tail. The apply stopped there, and the database stayed at version 15. The service stayed on the same task definition (`api:8`) with 2 tasks, and 55 of 55 requests returned 200. |
| Full destroy | 120 resources destroyed in 15 minutes, and teardown fixes 7 and 8 held. Afterwards: the ECS cluster is INACTIVE with no task definitions left, and there is no RDS instance, NAT gateway, Elastic IP, ALB, ECR repository, log group, Auto Scaling group, CloudFront distribution, VPC origin, VPC or `ecom` secret. |

## Backend review (2026-11-17)

A review of the Go backend and its binaries (`api`, `migrate`, `reconcile`, `db-bootstrap`, `fixtures`) after the task split. `go vet` and `govulncheck` were clean (no reachable vulnerabilities). The fixes became tasks 6–11 in [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md#milestone-17--cdn-frontend-and-load-balanced-api), ahead of the tag.

| # | Finding | Decision | Task |
|---|---|---|---|
| H1 | Per-IP limits key on the full address. CloudFront serves IPv6, and one client controls at least a /64, so it can rotate addresses past every per-IP limit. | Key IPv6 on its /64, with a looser /48 tier on `auth_ip` and `guest_bootstrap`; IPv4 unchanged. AWS WAF rate rules are noted for production, not added. | 6 |
| M2 | At most 10,000 live guest sessions, each living 30 days: ordinary traffic fills the cap in about a month, H1 in minutes, and then every new guest gets 503. Each creation also takes a global lock and counts all sessions. | Idle expiry (7 days, 30 at most), no global cap; per-prefix limits bound creation; scheduled cleanup. | 8 |
| M3 | Stock held by an order whose payment step was interrupted stays reserved until someone runs `reconcile`. Nothing runs it on AWS. | EventBridge Scheduler runs `reconcile --apply` every 5 minutes as a one-off task; a non-zero exit raises an SNS alert. A timer, not an alarm-triggered task: the alarm would need a metric that only a scheduled query could produce. | 10 |
| M4 | Reusing a rotated refresh token is refused but the session survives, so a thief who refreshes first keeps it. | Keep the previous token hash; a replay within 30 seconds is a tab race (401), later it revokes the session. | 9 |
| M5 | Registration answers `409 email_conflict` for an existing account, while password reset hides whether one exists. | Accepted and documented; registration gains the email-and-prefix limit. | 7 |
| L6 | A listener failure is reported only as "HTTP listener failed". | Log the error. | 11 |
| L7 | CloudFront forwards every viewer header, so with tracing on a visitor can choose the trace ID. | Ignore incoming `traceparent` unless a setting trusts an upstream. | 11 |
| L8 | Password change has no handler deadline. | 5 seconds, like the other auth handlers. | 11 |
| L9 | A recovered panic logs no value or stack. | Log the stack and the value's type, never the value. | 11 |
| L10 | Five failed sign-ins a minute lock any customer out, from anywhere. | Count failures per email and prefix, plus a looser email-only limit; successes do not count. | 7 |

Interactions: L10 and M2 depend on H1's prefix key; M3's job also runs M2's cleanup; M4 (and M2, if it needs one) adds an expand-only migration and raises `MinSchemaVersion`. Not reviewed in depth: the SQL query files, `fixturecmd`, `testmail` and the catalog.

## Out of scope

Multiple regions, autoscaling policies beyond a fixed task count, a web application firewall (WAF) rule set, a CSP beyond the current headers, blue/green tooling beyond ECS rolling updates, and background workers or queues (still reserved for Project 7).
