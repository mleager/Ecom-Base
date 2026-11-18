# AWS development stack: scope and cost analysis

This document explains three things about the Terraform stack in
`infrastructure/terraform`:

- why it's one development stack that a single `terraform apply` creates
- what it costs
- why it routes AWS API traffic through a NAT gateway rather than VPC
  interface endpoints

For how to apply, verify and destroy the stack, see
`infrastructure/terraform/README.md`.

## Scope: easy to try, not for production

This repository is Project 1 of the portfolio: the application and its
release. The Terraform stack is here so the application can be seen running
in its target shape on AWS:

- CloudFront serves the SPA from S3.
- Several ECS tasks behind an ALB serve `/api/*`.
- The API uses RDS PostgreSQL with verified TLS.

The stack was built to be easy to use, and that shaped it:

| Goal | What the stack does |
| --- | --- |
| A reviewer can try it with one command | One root module (`environments/development`) applies all five layer modules in one `terraform plan` and `apply`. |
| No setup outside the repository | Local state by default; the S3 backend is opt-in. Terraform builds and pushes the image itself, so Go and Node aren't needed. The domain is optional. |
| Clean, complete teardown | No deletion protection, no final snapshot, `force_destroy` on the bucket and ECR, and secrets without a recovery window. One `terraform destroy` removes everything (verified in M17 tasks 5 and 12). |
| Low cost for short sessions | One NAT gateway, one single-AZ `db.t4g.micro`, two `t3.small` instances, 7-day log retention, and no interface endpoints (see below). |
| Labelled as development | Folder name, README banner, and `Environment = development` on every resource. |

Production use rules each of these out. The stack:

- keeps generated secrets in Terraform state
- has one NAT gateway and one database instance, so each is a single point of failure
- uses self-signed internal certificates
- has no WAF and no access logs
- builds images on a laptop

**A full production deployment will be a separate project**, not this
repository. It will have its own Terraform roots, state, CI pipeline and
release process, and it will run this repository's released image pinned by
digest. The stack here stays a development and demonstration environment.

## Architecture of the development stack

```text
Browser ─HTTPS─▶ CloudFront (shop.<domain> or <id>.cloudfront.net)
                  ├─ default ─▶ S3 (private, OAC): SPA files + SPA-fallback function
                  └─ /api/*  ─▶ VPC origin ─▶ internal ALB (private subnets)
                                  └─HTTPS─▶ 2 API tasks, ECS on EC2 (private subnets)
                                         ├─TLS verify-full─▶ RDS PostgreSQL 16 (single AZ)
                                         └─SMTP STARTTLS──▶ Mailpit (Cloud Map)

Private subnets ─▶ NAT gateway (1, public subnet) ─▶ internet: ECS, ECR, Logs,
                                                     Secrets Manager, SSM, Docker Hub
Private subnets ─▶ S3 gateway endpoint (free): ECR image layers, S3
```

| Layer (module) | Decided design |
| --- | --- |
| `network` | VPC with 2 public and 2 private subnets in AZs that support CloudFront VPC origins; **one** NAT gateway; free S3 gateway endpoint; no interface endpoints. |
| `ecs-cluster` | EC2 capacity provider: ECS-optimized AL2023, IMDSv2, 2–3 `t3.small` with managed scaling, SSM Session Manager, no SSH, no inbound access. |
| `database` | RDS PostgreSQL 16 `db.t4g.micro`, 20 GB gp3, single AZ, private, `rds.force_ssl=1`, RDS-managed master password, 1-day backups. |
| `service` | ECR image pinned by digest; internal ALB behind a CloudFront VPC origin; 2 API tasks (`awsvpc`); one-off `db-bootstrap` and `migrate` tasks before each rollout; scheduled `reconcile` and `maintain` jobs every 5 minutes with an SNS failure alert; Mailpit for mail; one execution role per task definition. |
| `edge` | Private S3 bucket with OAC; CloudFront with the SPA fallback, cache and security header policies; optional ACM and Route 53. |

The API, job and Mailpit tasks themselves have no internet egress. Their
security groups allow only PostgreSQL and SMTP. Traffic to AWS APIs and image
registries comes from the **container instances**: the ECS agent, image
pulls, log delivery, secret retrieval and SSM. That traffic goes through
the NAT gateway.

## Cost of the development stack

The figures below are on-demand list prices for `us-east-1`, before the free
tier, Savings Plans and tax. Check the AWS pricing pages before you rely on
them. A month is 730 hours.

| Item | Unit price | Per day | Per month |
| --- | --- | --- | --- |
| NAT gateway | $0.045/hour + $0.045/GB processed | $1.08 | $32.85 |
| Public IPv4 address (NAT gateway only) | $0.005/hour | $0.12 | $3.65 |
| 2 × `t3.small` (3 during a rolling deploy) | $0.0208/hour each | $1.00 | $30.37 |
| 2 × 30 GB gp3 root volumes | $0.08/GB-month | $0.16 | $4.80 |
| Internal ALB | $0.0225/hour + LCUs (near zero at development traffic) | $0.54 | $16.43 |
| RDS `db.t4g.micro` | $0.016/hour | $0.38 | $11.68 |
| RDS 20 GB gp3 storage | $0.115/GB-month | $0.08 | $2.30 |
| Secrets Manager, CloudWatch Logs, S3, CloudFront, ECR, Scheduler, SNS, one alarm | usage | < $0.20 | < $6 |
| CloudFront VPC origin | no charge | – | – |
| **Total** | | **≈ $3.50** | **≈ $107** |

The stack is meant to run for a session and then be destroyed, not left
running for a month. Task 12's full re-verification ran for about 70 minutes
and cost well under $1.

## Decision: a NAT gateway, not VPC interface endpoints

The container instances need to reach AWS APIs. There are two ways to give
private subnets that access:

- **NAT gateway:** one managed gateway forwards all outbound traffic to the
  internet, including AWS public endpoints.
- **VPC interface endpoints (PrivateLink):** one endpoint per AWS service,
  each with a network interface in every subnet AZ, so traffic to that
  service never leaves the VPC.

### Endpoints this stack would need

To run without a NAT gateway, the stack would need these interface endpoints,
each in both AZs:

| Endpoint | Used for |
| --- | --- |
| `ecs`, `ecs-agent`, `ecs-telemetry` | ECS agent registration, task state and metrics |
| `ecr.api`, `ecr.dkr` | Image authorization and manifests (layers already go through the free S3 gateway endpoint) |
| `logs` | `awslogs` log delivery |
| `secretsmanager` | Secrets injected into task definitions |
| `ssm`, `ssmmessages`, `ec2messages` | Session Manager and the Mailpit port forwarding |

That is **10 interface endpoints × 2 AZs = 20 endpoint network interfaces**.

The `certs` and `mail-certs` init containers and Mailpit pull
`postgres:16-alpine` and `axllent/mailpit` from **Docker Hub**. Without a NAT
gateway they would also need an ECR pull-through cache rule. Docker Hub
requires credentials in Secrets Manager for that, so the change is more than
just endpoints.

### Cost comparison

An interface endpoint costs $0.01 per hour per AZ, plus $0.01 per GB
processed. For 20 endpoint network interfaces that's $4.80 a day, or
$146 a month.

| Option | Network access per day | Stack per day | Stack per month | Compared with now |
| --- | --- | --- | --- | --- |
| **One NAT gateway (chosen)** | $1.20 | **$3.50** | **$107** | 1× |
| 10 endpoints in 2 AZs, no NAT gateway | $4.80 | $7.10 | $216 | about 2× |
| 10 endpoints in 2 AZs, NAT gateway kept for Docker Hub and anything else | $6.00 | $8.30 | $253 | about 2.4× |
| 13 endpoints in 2 AZs (adding `sts`, `kms` and `monitoring`), NAT gateway kept | $7.44 | $9.74 | $296 | about 2.8× |
| 10 endpoints in 1 AZ only, no NAT gateway | $2.40 | $4.70 | $143 | about 1.3×, and it adds cross-AZ data charges and a single-AZ dependency |

Endpoints would make the **network access line 4–6 times higher** and the
**whole stack 2–3 times more expensive**. The common setup keeps the NAT
gateway alongside the endpoints, and it lands at the high end of that range.
Every endpoint option costs more than the one NAT gateway.

Processing is cheaper through an endpoint ($0.01 per GB) than through NAT
($0.045 per GB). That saving only pays for 20 endpoint interfaces once
traffic passes about **100 GB a day** of AWS API traffic. This stack's
traffic is a few megabytes of agent calls and logs, plus image manifests. The
image layers already skip the NAT gateway through the free S3 gateway
endpoint.

### What the decision gives up

- **Traffic to AWS APIs leaves the VPC.** It still goes over TLS to AWS public
  endpoints, but endpoint policies can't restrict it, for example to this
  account's ECR repository.
- **The container instances have open egress** (`0.0.0.0/0`). The task
  security groups are still restricted. Endpoints plus an ECR pull-through
  cache would let the instances' egress be limited to the endpoints'
  security group.

For a short-lived development stack with no real data, these don't justify
doubling or tripling the cost. The production project should decide this
again: there, egress control and endpoint policies may outweigh the cost.
With one NAT gateway per AZ, as production would use, the gap between the
two options is also smaller.

## How production will differ

The separate production project will make its own decisions. The current
plan, also listed in the README's "Production would differ" section:

- **Separate Terraform roots per layer** (network, data, service, edge) with
  remote state and locking, applied by CI over OIDC rather than from a laptop.
- **High availability:** one NAT gateway per AZ (or interface endpoints,
  decided there), Multi-AZ RDS with deletion protection, final snapshots and
  longer backups.
- **Edge:** always a domain with HTTPS through the VPC origin, a WAF, and
  CloudFront and ALB access logs.
- **Secrets:** generated outside Terraform state and rotated by Secrets
  Manager; internal certificates from a private CA.
- **Delivery:** images built and scanned in CI and promoted by digest;
  migrations run by the pipeline (`run_one_off_tasks = false`).
- **Mail and alerts:** a real SMTP provider instead of Mailpit; job alerts sent
  to an on-call tool through a KMS-encrypted topic.
