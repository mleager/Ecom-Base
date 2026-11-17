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
| `modules/database` | RDS PostgreSQL 16, `db.t4g.micro`, single-AZ and private, with `rds.force_ssl=1`. RDS manages the master password in Secrets Manager (never in Terraform state). The migrator and app credentials are separate secrets. |
| `modules/service` | An ECR repository; the image, built and pushed by the `kreuzwerker/docker` provider and pinned by digest; the internal ALB, its CloudFront VPC origin and the target group (`target_type = "ip"`, HTTPS to the tasks); the one-off `db-bootstrap` and `migrate` task definitions and the step that runs them; the API service (2 tasks, `awsvpc`); the Mailpit service with Cloud Map; internal TLS certificates; the API and mail secrets; and one execution role per task definition. |
| `modules/edge` | A private S3 bucket with OAC; the CloudFront distribution and its SPA-fallback function; cache, origin request and response headers policies; optional ACM and Route 53 records; and the SPA upload. |

### How the database jobs and the API start

An apply runs two one-off tasks before it touches the API service
(`modules/service/jobs.tf`):

```text
database ─▶ db-bootstrap (one-off) ─▶ migrate (one-off) ─▶ API service rolling deploy
            new database, new role     new image               only after migrate exits 0
            passwords or new code
```

1. **`db-bootstrap`** runs the image's `db-bootstrap` command as the RDS master
   user. It creates `ecom_migrator` and `ecom_app` if they are missing, sets
   their passwords, and hands the database and the `public` schema to
   `ecom_migrator` (the Go form of `infrastructure/postgres/init.sh`, adapted
   for RDS). It is idempotent and takes an advisory lock. The master password
   reaches only this task, and RDS manages and rotates it.
2. **`migrate`** runs `migrate up` as `ecom_migrator`, under the M16 advisory
   lock. If it fails, the apply stops before the service changes, and the
   running tasks keep serving.
3. **The API service** then rolls out. Each task runs two containers, chained
   with `dependsOn`:
   - **`certs`** (`postgres:16-alpine`, pinned to the same digest as Compose)
     writes the API's internal TLS certificate and key and the Mailpit CA to
     the task's shared volume, owned by user 65532. It has no database
     credentials.
   - **`api`** starts after `certs` exits 0, with `APP_ENV=production`,
     `TRUSTED_PROXY=cloudfront`, `STATIC_DIR=""` (S3 serves the SPA), and
     `TLS_CERT_FILE` and `TLS_KEY_FILE` pointing to the internal certificate.
     The ALB re-encrypts traffic to the tasks on port 8443 and checks
     `/health/ready`.

Because migrations run while the previous release still serves, **every
migration must work with the previous release's code**: add first, switch
the code, remove in a later release (`docs/updated/DECISIONS.md`).

The **RDS CA bundle** (`global-bundle.pem`, every region) is baked into the
image at `/etc/ssl/rds/global-bundle.pem`, pinned by checksum, so no task
downloads anything at start. The API tasks' security group therefore allows
egress only to PostgreSQL and Mailpit; image pulls, logs and secrets go
through the container instance, not the task.

Each task definition has **its own execution role**, which can read only its
own secrets:

| Task definition | Secrets it can read |
| --- | --- |
| `db-bootstrap` | RDS-managed master secret; the migrator and app secrets (passwords) |
| `migrate` | the migrator secret (connection URL) |
| `api` | the app database secret; the `api` secret (JWT key, SMTP password, TLS key) |
| `mail` | the `mail` secret (TLS key) |

Secrets reach the containers through the ECS `secrets` field. Each entry is
pinned to the current Secrets Manager version, so changing a secret creates a
new task definition. The RDS-managed master secret is the exception: RDS
rotates it, and `db-bootstrap` reads the current value.

**Running the jobs from a pipeline instead:** set `run_one_off_tasks = false`.
Terraform then only registers the task definitions, and the pipeline runs
`modules/service/files/run-task.sh` for `db-bootstrap` and `migrate` between
pushing the image and applying.

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
- **python3**, used by `run-task.sh` to build its AWS CLI arguments.
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

### Run a one-off task (`reconcile`, `migrate status`)

`run-task.sh` starts a task, waits for it to stop, prints each container's
exit code and log tail, and fails unless every container exited 0. Terraform
uses it for `db-bootstrap` and `migrate`. `reconcile` runs in the API task
definition with the `api` container's command replaced:

```bash
eval "$(terraform output -raw one_off_task_env)"
bash "$(terraform output -raw run_task_script)" ecom-development-api api reconcile --dry-run
bash "$(terraform output -raw run_task_script)" ecom-development-migrate migrate migrate status
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

- the migrator and app database passwords, and their connection URLs (the
  master password is managed by RDS and is not in state)
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
- **Migrations and bootstrap:** the same one-off tasks, run by a CI pipeline
  (`run_one_off_tasks = false`) with a check that each migration works with
  the previous release's code.
- **Images:** built and scanned in CI, then promoted by digest. Terraform would not
  build them on a laptop.
- **Internal TLS:** certificates from a private CA (for example AWS Private CA)
  instead of self-signed certificates in Terraform state.
