# AWS development stack: design

The app in its target shape on AWS: CloudFront serves the SPA from S3, and several ECS tasks behind a load balancer serve `/api/*`. The browser sees one HTTPS origin. One `terraform apply` builds the whole stack from this repository. How to run it is in [infrastructure/terraform/README.md](../../infrastructure/terraform/README.md); cost is in [COST.md](COST.md).

> **Development only.** One NAT gateway, single-AZ RDS, no deletion protection, Terraform-generated secrets in local state. A production deployment is a separate project that consumes this repository's released image by digest.

```text
Browser ─HTTPS─▶ CloudFront  (shop.<domain>, or <id>.cloudfront.net)
                  ├─ default ─▶ S3 (private, OAC): SPA + SPA-fallback function
                  └─ /api/*  ─▶ VPC origin ─▶ internal ALB (private subnets)
                                  └─HTTPS─▶ 2 API tasks, ECS on EC2 (private subnets)
                                         ├─TLS verify-full─▶ RDS PostgreSQL 16
                                         └─SMTP STARTTLS──▶ Mailpit (Cloud Map)
EventBridge Scheduler ─every 5 min─▶ reconcile + maintain task ─non-zero exit─▶ SNS alert
```

## Layout

One development root (`environments/development`) composes five modules: `network`, `ecs-cluster`, `database`, `service` and `edge`. Each mirrors a layer that production would apply as its own root with remote state. The reviewer needs Terraform, Docker and the AWS CLI. They don't need Go, Node or a state bucket, because the image is built inside Docker and state is local by default.

## Design choices

| Choice | Why | Trade-off accepted |
|---|---|---|
| **One root composed from layer modules** | A reviewer gets everything from one `apply`, and the modules split cleanly into separate roots later | One large state file, and a single blast radius |
| **ECS on an EC2 capacity provider**, `awsvpc`, IP target groups | Matches the owner's existing ECS pattern; the instances double as SSM port-forwarding hosts | Instance patching and capacity to manage, unlike Fargate |
| **Internal ALB behind a CloudFront VPC origin.** Its security group admits only `CloudFront-VPCOrigins-Service-SG` | No public ALB and no shared origin secret to rotate. The CloudFront prefix list would admit *every* distribution, so it needed a secret header; the VPC origin restricts by account. It also removes two public IPv4 addresses | Availability Zones without VPC origin support are skipped; a domain-mode switch replaces the origin, which takes up to 15 minutes |
| **The ALB re-encrypts to the tasks**, which keep TLS in Go with an internal certificate | The app's production rule (TLS required) stays unchanged; no "TLS ends upstream" switch | Internal certificates are renewed only by an apply |
| **Client IP from `CloudFront-Viewer-Address`**, trusted only when `TRUSTED_PROXY=cloudfront` | CloudFront sets the header itself, so viewers can't forge it; no hop counting | Requires the trust setting to be paired with this topology |
| **`/api/*` forwards all viewer headers** | CloudFront never forwards `Authorization` from a header allow-list; that was found on AWS, when every signed-in request got 401 | `Host` is forwarded too, so the ALB certificate also covers `shop.<domain>` |
| **Rate limits shared in PostgreSQL** (`RATE_LIMIT_STORE=postgres`) | Per-task counters would admit about twice the budget behind two tasks | One write per limited request; the limits fail closed |
| **`db-bootstrap` and `migrate` run as one-off ECS tasks before the service updates**, each with its own execution role | The RDS master secret reaches only the bootstrap task; a failed migration stops the apply before any task changes | Migrations must work with the previous release's code (expand, then contract) |
| **The apply waits for the rollout** (`wait_for_steady_state`), and the SPA is published only after it | A failed rollout fails the apply, and new frontend assets never go live ahead of the API they call | Applies take a few minutes longer |
| **The ALB checks `/health/live`, not `/health/ready`** | During a database outage, readiness would mark every task unhealthy and ECS would replace them in a loop | A task that can't reach the database still passes; `migrate` reaching the database just before the rollout covers most of that gap |
| **`reconcile --apply` every 5 minutes from EventBridge Scheduler**, with an SNS alert on a non-zero exit | Interrupted payments are settled within about 20 minutes without an operator, and failures are visible | A timer runs even when there is nothing to do (288 short tasks a day, under $0.01) |
| **RDS-managed master password; other secrets split by reader** (migrator, app, api, mail) | The most powerful credential is never in Terraform state; IAM grants per secret, not per JSON key | Generated app secrets still live in state, so state must stay private |
| **RDS CA bundle baked into the image**, pinned by checksum | Tasks download nothing at start, so their egress is limited to PostgreSQL and Mailpit | A republished bundle fails the build until the checksum is updated |
| **Optional domain** | Works for a reviewer without a domain (`*.cloudfront.net`, HTTP to the VPC origin). With a domain: ACM, Route 53, and HTTPS end to end. The hosted zone is only looked up, never managed | Two modes to test |
| **One NAT gateway, no interface endpoints** | 10 endpoints in 2 AZs would make the stack 2–3 times as expensive ([COST.md](COST.md)) | AWS API traffic leaves the VPC, and the instances have open egress |
| **AMI optionally pinned; rolling instance refresh** (launch first, 100–150 % healthy, ECS managed draining) | Either plans are stable, or AMI updates roll out without dropping capacity | AMI updates are deliberate |

## CDN rules

- **SPA fallback:** a CloudFront Function rewrites paths without a file extension to `/index.html`. There are no custom error responses, so API 404s stay JSON.
- **Caching** comes from S3 object metadata set at upload: `assets/*` is `immutable` for a year, `fixtures/v1/*` is cached for an hour, and everything else, including `index.html`, is `no-cache`. `/api/*` uses `CachingDisabled`.
- **Publish order:** hashed assets (never deleted, so open tabs keep working), then fixtures, then `index.html` last, then an invalidation of `/index.html`.
- **Headers:** HSTS and `nosniff` on every response; `Referrer-Policy` and `X-Frame-Options` on static responses.

## Proven on AWS

| Check | Result |
|---|---|
| Forged `X-Forwarded-For`, `X-Real-IP` and `CloudFront-Viewer-Address` on 26 sign-ins | Exactly 20 admitted, then 429, keyed on the real viewer |
| Direct requests to the ALB | Time out: it resolves to private addresses only |
| Shared limit across 2 tasks and a forced rolling deploy | Still 429 from the new tasks |
| One task stopped, then a rolling deploy, at about 8 requests per second | 3,996 of 3,996 requests returned 200 |
| A broken image | The circuit breaker rolled back after 3 minutes and the apply failed; 118 of 118 probes returned 200, the SPA wasn't published, and the next plan showed the change again |
| A failing migration | `migrate` exited 1 and the apply stopped; the service stayed on its old task definition, and 55 of 55 requests returned 200 |
| RDS stopped and started (about 9 minutes) | No task replaced and targets stayed healthy; requests returned 500 during the outage and 200 as soon as the database accepted connections |
| AMI change with an instance refresh | About 8 minutes, launch first; 223 of 223 probes returned 200 |
| A stranded order | The scheduled `reconcile` claimed and settled it; an injected failure published the SNS alert |
| Browser journeys (account and guest, with emailed links via Mailpit) | Pass in both domain modes |
| Drift and teardown | No changes on re-plan; `destroy` removes all 133 resources |

## Defects found by running it

Running the stack on AWS found real defects that `validate` and `plan` didn't:

- **Bearer tokens weren't forwarded.** A header allow-list can't include `Authorization`.
- **Destroy order.** The NAT gateway, public route table, instance egress rule and ECS IAM attachment could be destroyed while ECS still ran in the private subnets. The agents lost their route, and services hung in `DRAINING`. This was fixed with explicit dependencies, and later destroys removed every resource cleanly.
- **The schedule ran before the migrations** on a fresh apply. The alert fired, correctly, and the schedule now depends on `migrate`.
- **A sensitive SSM value in an output** failed `plan`, though `validate` passed.
- **An `ADD --chmod` directory mode** left the CA bundle unreadable by the non-root user. `release-evidence.sh` now checks for it.

## Known limits

- Internal certificates renew only on apply: after 90 days without one, mail stops, because the API verifies Mailpit's certificate.
- `t3.small` instances give 6 `awsvpc` task slots; a rolling deploy briefly needs 5–6.
- A database outage shows as 500 on most routes.

## Production would differ

Separate roots per layer, applied by CI over OIDC; one NAT gateway per AZ or interface endpoints; Multi-AZ RDS with deletion protection and longer backups; always a domain, plus a WAF and access logs; secrets generated outside state and rotated; internal TLS from a private CA; images built and scanned in CI and promoted by digest; a real SMTP provider; alerts to an on-call tool through a KMS-encrypted topic.
