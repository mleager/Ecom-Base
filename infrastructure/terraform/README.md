# AWS development stack

> [!WARNING]
> **Development only.** This stack is for trying the app in its target shape and
> running its checks. It uses one NAT gateway, a single-AZ database without
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

The design, its trade-offs and what was proven on AWS are in
[docs/terraform/DESIGN.md](../../docs/terraform/DESIGN.md); cost is in
[docs/terraform/COST.md](../../docs/terraform/COST.md). This page is the
operator guide.

## What a single apply creates

| Module | Contents |
| --- | --- |
| `modules/network` | VPC, 2 public and 2 private subnets (AZs with CloudFront VPC origin support), one NAT gateway, S3 gateway endpoint |
| `modules/ecs-cluster` | ECS on an EC2 capacity provider: ECS-optimized AL2023 (or `ecs_ami_id`), IMDSv2, 2–3 `t3.small`, managed scaling and draining, SSM Session Manager, no SSH |
| `modules/database` | RDS PostgreSQL 16 `db.t4g.micro`, single AZ, private, `rds.force_ssl=1`, RDS-managed master password |
| `modules/service` | ECR and the image (built by the `kreuzwerker/docker` provider, pinned by digest); internal ALB, VPC origin and target group; one-off `db-bootstrap` and `migrate` tasks; the API service (2 tasks); scheduled `reconcile` and `maintain` with an SNS alert; Mailpit with Cloud Map; per-task execution roles and secrets |
| `modules/edge` | Private S3 bucket with OAC, CloudFront with the SPA-fallback function and header policies, optional ACM and Route 53, and the SPA upload |

An apply runs in this order (`modules/service/jobs.tf`):

```text
database ─▶ db-bootstrap (one-off) ─▶ migrate (one-off) ─▶ API rolling deploy ─▶ SPA publish
            new database, role         new image             waits for steady      only after the
            passwords or code                                state (30 min max)    API is steady
```

A failed `migrate` or a rolled-back deployment fails the apply; the running
tasks keep serving and the previous SPA stays live. Every migration must work
with the previous release's code. To run the one-off tasks from a pipeline
instead, set `run_one_off_tasks = false` and call
`modules/service/files/run-task.sh` between pushing the image and applying.

**AMI updates:** unpinned, the launch template follows AWS's recommended
ECS AMI, and a new one shows up in the next plan. Pin it with `ecs_ami_id`
(the `ecs_ami_id` output shows the one in use). A change starts an instance
refresh; follow it with
`aws autoscaling describe-instance-refreshes --auto-scaling-group-name ecom-development-ecs`.

**Domain modes:** with `domain_name` unset, the site is
`https://<id>.cloudfront.net` and CloudFront reaches the ALB over HTTP. With
it set (in `local.auto.tfvars`), the site is `https://shop.<domain>` with ACM
certificates and HTTPS to `origin.<domain>`. The hosted zone must already
exist; this stack only looks it up.

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

### Scheduled jobs (`reconcile`, `maintain`)

`modules/service/schedule.tf` (M17 task 10). EventBridge Scheduler starts
one task of the `scheduled-jobs` family every 5 minutes (`job_schedule`),
on the capacity provider, in the private subnets, with the jobs security
group (PostgreSQL egress only). Its two containers run in order:

1. **`reconcile`** runs `reconcile --apply --limit 100` as `ecom_app`. It
   settles orders left in `pending_payment` after their reservation deadline,
   for example when a task stopped mid-checkout (`docs/backend/OPERATIONS.md`).
2. **`maintain`** runs `maintain guests` as `ecom_migrator` once `reconcile`
   has stopped, whatever its exit code. It removes expired guest data in
   batches.

Each stops within about 2 minutes, and both use row locks with `SKIP LOCKED`,
so a slow run overlapping the next one is safe. Their output is in the log
group under `scheduled/reconcile/<task id>` and `scheduled/maintain/<task id>`.

**Failure alert:** an EventBridge rule matches a `scheduled-jobs` task that
stops with any non-zero container exit code, or fails to start, and publishes
the ECS event to the `<name>-job-alerts` SNS topic. A CloudWatch alarm on the
schedule group's `TargetErrorCount` (the scheduler could not call RunTask)
uses the same topic. Set `alert_email` to subscribe an address; AWS mails it
a confirmation link, and nothing is delivered until it's confirmed. The
topic is unencrypted because EventBridge cannot publish to a topic encrypted
with the AWS-managed SNS key; messages carry task ARNs and exit codes only.

The scheduler's role can run only this task family on this cluster and pass
only its execution role. Set `schedule_jobs = false` to keep the schedule
disabled, for example while testing a stranded order by hand.

Locally, nothing is scheduled: `bash scripts/dev.sh reconcile` and
`bash scripts/dev.sh maintain guests` stay manual commands.

## Cost

About **$3.50 per day** (about $107 a month) in `us-east-1` while the stack is
up, mostly the NAT gateway, two instances, the ALB and RDS. Destroy it when
you're done. Breakdown: [docs/terraform/COST.md](../../docs/terraform/COST.md).

## Apply

```bash
cd infrastructure/terraform/environments/development
terraform init
terraform plan -var-file=terraform.tfvars.development -out=dev.tfplan
terraform apply dev.tfplan
```

- **Duration:** the first apply takes about 15–20 minutes. RDS and CloudFront take
  the longest, and the image build adds a few minutes more.
- **Domain:** the committed `terraform.tfvars.development` leaves
  `domain_name` unset, so a fresh clone applies in the `*.cloudfront.net`
  mode. To use your own domain, copy `local.auto.tfvars.example` to
  `local.auto.tfvars` (gitignored, loaded automatically) and set
  `domain_name` there before you plan. Values passed with `-var-file`
  override `*.auto.tfvars`, so don't also set it in the shared file.
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

The checks run against this stack, and their results, are in
[docs/terraform/DESIGN.md](../../docs/terraform/DESIGN.md#proven-on-aws).

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

## Known limits

- **Internal certificates renew only on apply.** Terraform's `tls` provider
  issues the internal CA (1 year) and the API and Mailpit certificates
  (90 days each). A plan within 14 days of a certificate's expiry (30 for
  the CA) replaces it, and the apply rolls out new task definitions; nothing
  renews them while the stack just runs. The ALB doesn't verify the API's
  certificate, so that one expiring changes nothing, but the API verifies
  Mailpit's: **after 90 days without an apply, mail stops** (the TLS
  handshake fails, and the user sees the send as unconfirmed). Re-apply, or destroy the stack long before
  then; it is meant for short sessions.
- **Six task slots.** A `t3.small` has 3 network interfaces, one for the
  host, so each instance runs at most 2 `awsvpc` tasks, and the Auto Scaling
  group's maximum of 3 instances gives 6 slots. Steady state uses 3 (2 API
  tasks and Mailpit), plus a scheduled job for a few seconds every 5
  minutes. A rolling deploy briefly needs 5–6 (4 API tasks at 200%). If a
  job or one-off task starts at that moment, the extra task waits for a
  slot (`PROVISIONING`) until the deploy finishes. More API tasks need a
  larger `asg_max_size` or an instance type with more network interfaces.
- **A database outage shows as `500 internal_error`.** Most routes don't
  classify database errors, so clients and the request log see a generic
  500 (routes that already classify unavailability, such as guest
  capacity, answer 503). The cause shows in `/health/ready`, RDS events and,
  with tracing on, the query spans. Tasks stay in service and recover on
  their own (see [DESIGN.md](../../docs/terraform/DESIGN.md)).

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

See [docs/terraform/DESIGN.md](../../docs/terraform/DESIGN.md#production-would-differ).
