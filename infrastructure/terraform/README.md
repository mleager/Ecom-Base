# AWS development stack (Milestone 17)

> [!WARNING]
> **Development only.** This stack is for trying the app in its target shape and
> running the M17 checks. It uses one NAT gateway, a single-AZ database without
> deletion protection, self-signed internal certificates and Terraform-generated
> secrets kept in local state. Don't put real users or real data on it. See
> [Production would differ](#production-would-differ).

The local Docker/Compose deployment (`compose.deploy.yaml`, M14–M16) is still the
default way to run the app. This folder adds a second option.

```text
Browser ─HTTPS─▶ CloudFront  (https://shop.<domain>, or https://<id>.cloudfront.net)
                  ├─ default ─▶ S3 bucket (private, OAC): dist/   + SPA-fallback function
                  └─ /api/*  ─HTTPS or HTTP─▶ VPC origin ─▶ internal ALB (private subnets)
                                  └─HTTPS (self-signed)─▶ 2 ECS tasks on EC2 (private subnets)
                                         ├─TLS verify-full─▶ RDS PostgreSQL 16 (private)
                                         └─SMTP STARTTLS──▶ Mailpit (Cloud Map: mail.<name>.internal)
```

## What a single apply creates

Run one `terraform apply` in `environments/development`. It applies five modules,
each matching one of the layered `tf-*` repositories:

| Module | Contents |
| --- | --- |
| `modules/network` | A VPC with 2 public and 2 private subnets, **one** NAT gateway, and an S3 gateway endpoint (free). Availability Zones without CloudFront VPC origin support (such as `use1-az3`) are skipped. |
| `modules/ecs-cluster` | An ECS cluster on an EC2 capacity provider: the ECS-optimized AL2023 AMI (from SSM), a launch template with IMDSv2, an Auto Scaling group with 2–3 `t3.small` in the private subnets, managed scaling, and an instance role with SSM Session Manager. The instances have no SSH and no inbound access. |
| `modules/database` | RDS PostgreSQL 16, `db.t4g.micro`, single-AZ and private, with `rds.force_ssl=1`. Its passwords and connection URLs are stored in Secrets Manager. |
| `modules/service` | An ECR repository; the image, built and pushed by the `kreuzwerker/docker` provider and pinned by digest; the internal ALB, its CloudFront VPC origin and the target group (`target_type = "ip"`, HTTPS to the tasks); the API service (2 tasks, `awsvpc`); the Mailpit service with Cloud Map; internal TLS certificates; and the application secrets. |
| `modules/edge` | A private S3 bucket with OAC; the CloudFront distribution and its SPA-fallback function; cache, origin request and response headers policies; optional ACM and Route 53 records; and the SPA upload. |

### How a task starts

Each API task runs three containers in order, chained with `dependsOn`:

1. **`db-bootstrap`** uses `postgres:16-alpine`, pinned to the same digest as Compose.
   - It writes four files to the task's shared volume, owned by user 65532:
     - the regional RDS CA bundle
     - the Mailpit CA
     - the API's internal TLS certificate and key
   - It then runs an RDS-adapted, idempotent version of the role SQL in
     `infrastructure/postgres/init.sh` (see `modules/service/files/db-bootstrap.sh`).
2. **`migrate up`** runs the M16 migration job, which holds an advisory lock. It
   connects as `ecom_migrator` with `sslmode=verify-full`.
3. **`api`** starts only after both earlier containers exit 0. Its settings:
   - `APP_ENV=production`
   - `TRUSTED_PROXY=cloudfront`
   - `STATIC_DIR=""` (S3 serves the SPA)
   - `TLS_CERT_FILE` and `TLS_KEY_FILE` point to the internal certificate.

   The ALB re-encrypts traffic to the tasks on port 8443 and checks `/health/ready`.

Secrets reach the containers through the ECS `secrets` field. Each entry is
pinned to the current Secrets Manager version, so changing a secret creates a
new task definition.

### Domain modes

The `domain_name` variable chooses between two modes.

| | `domain_name` unset (default) | `domain_name = "example.com"` |
| --- | --- | --- |
| Browser URL | `https://<id>.cloudfront.net` | `https://shop.example.com` (ACM in us-east-1) |
| CloudFront → ALB (VPC origin) | **HTTP** on port 80, using the ALB DNS name | **HTTPS** on port 443, using `origin.example.com` (regional ACM for `origin.` and `shop.`) |
| ALB → tasks | HTTPS on port 8443 | HTTPS on port 8443 |

The ALB is locked down the same way in both modes:
- It is **internal**, in the private subnets, with no public address. CloudFront
  reaches it through a **VPC origin**: service-managed network interfaces that
  CloudFront places in the private subnets.
- Its security group admits only `CloudFront-VPCOrigins-Service-SG`, which AWS
  creates with the first VPC origin in the VPC. That group carries traffic only
  for this account's distributions, so no shared origin secret is needed (the
  public prefix list would admit every CloudFront distribution).
- The VPC origin takes up to 15 minutes to deploy. A domain-mode switch replaces
  it, along with the listener, because a VPC origin can't be edited while a
  distribution uses it.

The hosted zone must already exist, for example from `tf-globals`. This stack
only looks it up, so `terraform destroy` never deletes it.

### CDN rules (from `docs/updated/MILESTONE_17.md`)

- **SPA fallback:** a CloudFront Function on the S3 behavior rewrites paths
  without a file extension to `/index.html`. The distribution has no custom
  error responses, so API 404s stay JSON.
- **Caching:** set as S3 object metadata at upload, and honoured by the cache
  policy (min TTL 0):

  | Files | `Cache-Control` |
  | --- | --- |
  | `assets/*` | `public, max-age=31536000, immutable` |
  | `fixtures/v1/*` | `public, max-age=3600` |
  | Everything else, including `index.html` | `no-cache` |
- **`/api/*` behavior:**
  - Uses `Managed-CachingDisabled` and allows all methods.
  - Forwards every viewer header, cookie and query string, and adds
    `CloudFront-Viewer-Address`. A header whitelist can't include
    `Authorization`, which carries the API's bearer access token; CloudFront
    forwards it only with a policy that forwards all viewer headers. That
    includes `Host`, so with a domain the ALB certificate also covers
    `shop.<domain>`. CloudFront sets `CloudFront-Viewer-Address` itself,
    so a viewer can't supply it (checked in M17 task 5).
  - Passes `Set-Cookie` back unchanged.
- **Headers:**
  - Every response gets HSTS (`max-age=31536000`) and `nosniff`.
  - Static responses also get `Referrer-Policy: no-referrer` and
    `X-Frame-Options: DENY`. A response headers policy can't match on content
    type, so assets get these headers too, which does no harm.
- **Publish order** (`modules/edge/files/publish-spa.sh`): hashed assets first
  (never deleted, so open tabs keep working), then `fixtures/v1`, then other
  files, then `index.html` last, then an invalidation of `/index.html`.

## Prerequisites

- **Terraform** 1.12 or later (tested with 1.12.2). Providers are pinned in
  `environments/development/providers.tf` and `.terraform.lock.hcl`:

  | Provider | Version |
  | --- | --- |
  | `hashicorp/aws` | 6.70.0 |
  | `hashicorp/random` | 3.9.1 |
  | `hashicorp/tls` | 4.4.2 |
  | `kreuzwerker/docker` | 4.6.0 |
- **Docker** with BuildKit/buildx, which the Dockerfile's `RUN --mount` needs.
  Terraform builds a `linux/amd64` image on this machine. On an arm64 machine, the
  build goes through emulation and is slow.
- **AWS CLI v2**, signed in to the target account with the same credentials
  Terraform uses. The upload step calls `aws s3` and `aws cloudfront`.
- **Session Manager plugin** for the AWS CLI. It's only needed to open the
  Mailpit UI.
- You don't need Go or Node. Both builds happen inside the image.

## Cost

About **$3–3.25 per day** in `us-east-1` while the stack is up. Destroy it when
you're done.

| Item | Approx. per day |
| --- | --- |
| NAT gateway (hourly charge, plus data) | $1.10 |
| 2 × `t3.small` ECS instances (3 during a rolling deploy) + 2 × 30 GB gp3 | $1.16 |
| Application Load Balancer (internal) | $0.55 |
| RDS `db.t4g.micro` + 20 GB gp3 | $0.45 |
| Public IPv4 address (NAT only; the internal ALB has none) | $0.12 |
| Secrets Manager (2 secrets), CloudWatch Logs, S3, CloudFront, ECR | < $0.20 |
| CloudFront VPC origin | no charge |

## Apply

```bash
cd infrastructure/terraform/environments/development
terraform init
terraform plan -var-file=terraform.tfvars.development -out=dev.tfplan
terraform apply dev.tfplan
```

- **Duration:** the first apply takes about 15–20 minutes. RDS and CloudFront take
  the longest, and the image build adds a few minutes more.
- **Domain:** to use one, set `domain_name` in `terraform.tfvars.development`
  before you plan.
- **Remote state:** to keep state in your own S3 bucket, copy
  `backend.s3.tf.example` to `backend.s3.tf`, set the bucket name and run
  `terraform init -migrate-state`.
- **Redeploying:** after a source change, run the same plan and apply. The changed
  files produce a new image tag and digest, which triggers a rolling update of the
  API tasks and a new SPA upload.

## Verify

Switching between the two domain modes is a normal plan and apply. The ALB
listener and the VPC origin are replaced when the protocol changes. CloudFront can take a while to
release the `shop.` certificate; if destroying it fails with "in use", the next
apply retries or reuses it.

```bash
url=$(terraform output -raw site_url)
alb=$(terraform output -raw alb_dns_name)

curl -fsS "$url/api/v1/products" | head -c 300; echo   # API through CloudFront
curl -fsSI "$url/orders/does-not-exist"                 # deep link -> index.html (200, no-cache)
curl -fsSI "$url/" | grep -iE 'strict-transport|x-content-type|x-frame|referrer'
curl -sS -o /dev/null -w '%{http_code}\n' "$url/api/v1/nope"   # API 404 stays JSON, not HTML

# Direct to the ALB: unreachable. Its name resolves to private addresses, so
# expect a timeout from your machine.
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' "http://$alb/api/v1/products" || echo 'blocked'
```

To check that the tasks are healthy and see their logs:

```bash
aws ecs describe-services --cluster "$(terraform output -raw ecs_cluster_name)" \
  --services "$(terraform output -raw api_service_name)" \
  --query 'services[0].{running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}'
aws logs tail "$(terraform output -raw log_group_name)" --since 15m
```

The full M17 release gates are in `docs/updated/MILESTONE_17.md`. They cover
spoofed client-IP headers, shared limits across tasks, stopping a task under
traffic, and running the HTTPS browser group against `site_url`.

### Read captured mail (Mailpit UI)

Mailpit isn't exposed publicly. To reach it, forward its UI through one of the
container instances using SSM:

```bash
eval "$(terraform output -raw mailpit_ui_command)"
# then open http://localhost:8025
```

That output expands to the following two commands:

```bash
instance_id=$(aws ec2 describe-instances --filters Name=tag:aws:autoscaling:groupName,Values=ecom-development-ecs \
  Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
aws ssm start-session --target "$instance_id" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters 'host=mail.ecom-development.internal,portNumber=8025,localPortNumber=8025'
```

### Run `reconcile` as a one-off task

```bash
aws ecs run-task --cluster "$(terraform output -raw ecs_cluster_name)" \
  --task-definition "$(terraform output -raw api_task_definition_family)" \
  --capacity-provider-strategy capacityProvider=ecom-development-ec2,weight=1 \
  --network-configuration 'awsvpcConfiguration={subnets=[<private-subnet-id>],securityGroups=[<api-sg-id>]}' \
  --overrides '{"containerOverrides":[{"name":"api","command":["reconcile","<args>"]}]}'
```

## Destroy

```bash
terraform destroy -var-file=terraform.tfvars.development
```

This removes everything, including the following, which have development-only
settings so they can be deleted cleanly:

- the S3 bucket (`force_destroy`)
- the ECR images (`force_delete`)
- the database (no final snapshot)
- the secrets (no recovery window)

The Route 53 hosted zone is never touched.

Destroy order matters: the private subnets' consumers (ECS instances and
tasks, RDS, the ALB and its VPC origin) are removed before the NAT gateway, and
the NAT gateway before the public routes and the internet gateway. The
container instances' egress rule and ECS permissions also stay until the
instances are gone. Without a route out, the ECS agent cannot report stopped
tasks, their network interfaces stay attached, and service deletion hangs in
`DRAINING`.

Afterwards, check that nothing is left. The tagging API lags behind deletions
for a while and also lists `INACTIVE` task definitions and clusters, which
cost nothing; check anything else it lists directly:

```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=ecom Key=Environment,Values=development \
  --query 'ResourceTagMappingList[].ResourceARN'
aws ec2 describe-vpcs --filters Name=cidr,Values=10.40.0.0/16 --query 'Vpcs[].VpcId'
aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier'
```

CloudFront functions and policies can take a few minutes to delete after the
distribution is disabled. If `destroy` reports one as still in use, run it again.
The same applies to the VPC origin's network interfaces and
`CloudFront-VPCOrigins-Service-SG`, which AWS removes some time after the VPC
origin is deleted: if a subnet, security group or the VPC fails with
`DependencyViolation`, wait a few minutes and run `destroy` again.

## State holds secrets

Terraform creates these values with the `random` and `tls` providers:

- the database master, migrator and app passwords, and the connection URLs
- the JWT key
- the SMTP password
- the TLS private keys

They are copied to Secrets Manager, and they are also stored **in plain text in
`terraform.tfstate`**. So:

- Never commit the state file. `.gitignore` excludes it.
- Never paste it anywhere.
- If you use the S3 backend, the bucket must be private, encrypted and
  versioned.

The outputs contain no secret values, only ARNs and names.

## Production would differ

- **Separate roots per layer** (network, data, service, edge), linked with
  `terraform_remote_state`, each with its own S3 state and a lock file. CI
  would plan and apply them over OIDC (`tf-shared-actions`).
- **Availability:** one NAT gateway per AZ, Multi-AZ RDS with deletion protection,
  final snapshots and longer backup retention. Mail would go through a real
  SMTP provider such as SES instead of Mailpit.
- **Always a domain:** HTTPS from CloudFront through the VPC origin. Also a WAF
  and ALB/CloudFront access logs.
- **Secrets:** generated outside Terraform, or with write-only arguments, so they
  never land in state, and rotated by Secrets Manager.
- **Migrations:** run as a separate one-off task (or pipeline step) before the
  deploy, not as an init container in every API task.
- **Images:** built and scanned in CI, then promoted by digest. Terraform would not
  build them on a laptop.
- **Internal TLS:** certificates from a private CA (for example AWS Private CA)
  instead of self-signed certificates in Terraform state.
