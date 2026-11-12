# M17 plan: AWS development stack with Terraform (CloudFront + ALB + ECS on EC2)

## Context

Milestone 17 is the next step after the `v1.0.0` tag on `main`. Its goal is to run the
app in its target shape:
- CloudFront serves the SPA from S3.
- The Go API runs as several ECS tasks behind an ALB.
- The browser still sees one HTTPS origin.

The user deploys infrastructure only to AWS, using Terraform. Their existing repos split the
work into layers, linked with `terraform_remote_state`:
- `mleager/tf-aws-account`: the S3 state bucket, locked with `use_lockfile`.
- `tf-networking`: the VPC, two public and two private subnets, one NAT.
- `tf-ecs`: an EC2 Auto Scaling group capacity provider, `awsvpc` networking and IP target groups.
- `tf-rds`.
- `tf-cloudfront`.

Common conventions across them: a pinned AWS provider, `default_tags` for Project and
Environment, `terraform.tfvars.development`, a partial `backend "s3" {}`, and GitHub Actions
over OIDC through `tf-shared-actions`.

Decisions so far:
- The domain is optional. You'll register a new one and set it in your tfvars; a reviewer
  without one gets the `*.cloudfront.net` address.
- The repository stays local, with no GitHub Actions for now.
- Compute is the EC2 capacity provider.
- A reviewer must be able to run `terraform plan` and `terraform apply` once and get the
  whole stack.
- The stack must clearly be for **development only**. Production would be split into
  separate layers.

The local Docker/Compose path (M14–M16) stays unchanged and remains the default.

## Recommended layout: one development root that uses layer modules

```text
infrastructure/
  postgres/                      (unchanged: local Compose bootstrap)
  terraform/
    README.md                    prerequisites, cost, apply, verify, destroy, "dev only" notice
    modules/                     one module per layer, mirroring the tf-* repos
      network/                   VPC, 2 public + 2 private subnets, 1 NAT (dev: single AZ NAT)
      ecs-cluster/               ECS-optimized AMI launch template, ASG, capacity provider, SSM role
      database/                  RDS PostgreSQL 16 (private), parameter group (rds.force_ssl), Secrets Manager entries
      service/                   ECR, ALB, target group, task definition, ECS service, log group, IAM
      edge/                      private S3 bucket + OAC, CloudFront (2 behaviors), function, header policies
    environments/
      development/               THE root module a reviewer applies
        main.tf  providers.tf  variables.tf  outputs.tf  terraform.tfvars.development
        backend.s3.tf.example    opt-in remote state (the user's own bucket, use_lockfile)
```

- **One command:** run `terraform apply -var-file=terraform.tfvars.development` in
  `environments/development` and the whole stack is created. By default state is local, so a
  reviewer doesn't need a state bucket. Copying `backend.s3.tf.example` switches to the
  user's own S3 bucket, using the same pattern as `tf-aws-account`.
- **Development only, stated clearly:**
  - The folder name, the README banner and the `Environment = development` default tag all
    say so.
  - It uses one NAT gateway, a single-AZ RDS instance, `deletion_protection = false` and
    `skip_final_snapshot`.
  - The README has a short "Production would differ" section: separate roots per layer
    (network, data, service, edge) with remote state, Multi-AZ, a domain with ACM, a WAF,
    and CI with OIDC.
- **Conventions copied from the user's repos:** a pinned `hashicorp/aws` provider,
  `default_tags`, `terraform.tfvars.development`, `awsvpc` networking with
  `target_type = "ip"`, and capacity-provider managed scaling. Provider versions are pinned
  under the project's two-week rule; Terraform 1.12.2 is installed locally.

## How the stack fits together

```text
Browser ─HTTPS─▶ CloudFront (shop.<domain>, or *.cloudfront.net)
                  ├─ default ─▶ S3 dist/ via OAC (+ CloudFront Function for the SPA fallback)
                  └─ /api/*  ─HTTPS (domain) or HTTP (none) + secret header─▶ ALB (CloudFront prefix list only)
                                    └─HTTPS (self-signed)─▶ ECS tasks (EC2, awsvpc, private) ─TLS verify-full─▶ RDS
```

- **Domain is optional.** `domain_name` is a variable that defaults to `null`.
  - **Set** (your tfvars): Route 53 alias `shop.<domain>` → CloudFront, and
    `origin.<domain>` → ALB. One ACM certificate in us-east-1 for CloudFront and one
    regional certificate for the ALB, both DNS-validated. CloudFront → ALB uses HTTPS only.
    The hosted zone is looked up as a data source and is never created or destroyed by this
    stack.
  - **Unset** (a reviewer without a domain): the `*.cloudfront.net` address, and CloudFront
    → ALB over HTTP.
  - Both modes lock the ALB down the same way:
    - The ALB security group accepts only the AWS-managed CloudFront origin-facing prefix
      list.
    - The listener has a default 403 rule and forwards only when the secret origin header is
      present (a `random_password`, stored in Secrets Manager).
- **The ALB re-encrypts to the tasks over HTTPS in both modes, so there's no app TLS
  change.**
  - The `tls` provider issues an internal self-signed certificate. ALB doesn't verify target
    certificates.
  - The `db-bootstrap` init container writes that certificate to the shared task volume.
  - The API's existing production rule (`TLS_CERT_FILE` and `TLS_KEY_FILE` required) stays
    as it is. Secure cookies and the `__Secure-` cookie names don't change.
  - A CloudFront response headers policy also sends HSTS and the HTML security headers.
- **The task definition chains three containers** using `dependsOn`:
  1. **`db-bootstrap`** (pinned `postgres:16-alpine`): an idempotent, RDS-adapted copy of
     `infrastructure/postgres/init.sh`. It uses `CREATE ROLE … IF NOT EXISTS` through a
     `DO` block, and `GRANT ecom_migrator TO <master>` before `ALTER DATABASE OWNER`. It
     then writes the RDS regional CA bundle and the mail CA to a shared task volume.
  2. **`migrate`**: the M16 `migrate up`. Its advisory lock makes concurrent tasks safe, and a
     task with nothing new to apply changes nothing.
  3. **`api`**: starts only after both earlier containers exit successfully.

  Migrations therefore always run before a task receives traffic, without a separate
  pipeline step. The README notes that production would run migrations as a separate
  one-off task instead.
- **Secrets** come from Secrets Manager and are injected with `secrets` in the task
  definition: the database master, migrator and app passwords, the JWT secret, the SMTP
  password and the origin header secret. Terraform generates them with `random_password`, so
  they are stored in Terraform state; the README warns about that.
- **Mail:** a Mailpit ECS service in the private subnets, reached through Cloud Map DNS, with
  a TLS certificate from the `tls` provider. Its UI is reached by SSM port forwarding through
  an ECS instance, following `tf-rds`'s SSM-only pattern. No mail leaves AWS.
- **Image and frontend:**
  - The `kreuzwerker/docker` provider builds the image from the repository and pushes it to
    ECR, pinned by digest.
  - A `terraform_data` resource with `local-exec` copies `/app/dist` out of that image and
    runs `aws s3 sync`:
    1. Hashed assets first, with `immutable` caching.
    2. Then `fixtures/v1`.
    3. Then `index.html`, with `no-cache`.
  - Finally it invalidates `/index.html`.
  - So a reviewer needs Terraform, Docker and the AWS CLI, but not Go or Node.

## Implementation tasks, in order (to go into IMPLEMENTATION_SEQUENCE.md)

1. **Record the M17 decisions.** Update MILESTONE_17.md and DECISIONS.md with the choices
   above: Terraform, the development root plus modules, the optional domain (ACM and an
   HTTPS origin, or HTTP when it's unset), the ALB re-encrypting with a self-signed task
   certificate, EC2 capacity provider, `CloudFront-Viewer-Address`,
   PostgreSQL-backed shared limits, init-container migrations, Mailpit on ECS, and local state
   by default.
2. **App: client IP.** One helper that trusts `CloudFront-Viewer-Address` only when it's
   configured (`TRUSTED_PROXY=cloudfront`). Use it in `auth.allowPeer` and in the guest
   admission and bootstrap limits. Local mode keeps `RemoteAddr`, and tests prove that a
   spoofed header has no effect.
3. **App: shared rate limits.** Migration 14, a PostgreSQL counter table, behind the existing
   `auth.RequestLimiter` and guest `limiter` interfaces. Concurrency slots stay per task. Add
   integration tests covering two limiter instances against one database, and record the
   audit of process-local state.
4. **Terraform modules and the development root**, as laid out above, including the README
   (cost of about $3 a day, `terraform destroy`), the example S3 backend, and both domain
   modes.
5. **Verification against AWS** (in both domain modes):
   - Release gates 2–6 from MILESTONE_17.md.
   - The HTTPS browser group pointed at the CloudFront URL.
   - Spoofed headers, and direct requests to the ALB without the secret header, are refused.
   - A shared limit holds across 2 tasks and a rolling deploy.
   - Stopping one task during traffic causes no failures.
   - `reconcile` runs as a one-off task.
6. **Evidence, teardown and tag:**
   - Record the image digest, Terraform and provider versions, and the distribution and
     service IDs (no secrets).
   - `terraform destroy` removes everything, with the cost noted.
   - Run the full local regression, then tag `v1.1.0`.

Tasks 2 and 3 are Go changes and come first. Task 4 can be written alongside them, but the
stack can't pass its gates until those changes ship in an image.

Before task 4: register the domain and create its Route 53 hosted zone outside this stack,
for example in your `tf-globals`. The zone is long-lived, and destroying the development
stack must not delete it.

## Files

- **New:** `infrastructure/terraform/**`, and the M17 entries in `docs/updated/` (MILESTONE_17,
  DECISIONS, IMPLEMENTATION_SEQUENCE, STATUS, and a new `AWS_DEPLOYMENT.md`, or a section
  in RELEASE.md).
- **Changed:**
  - `backend/internal/platform/config/` (the `TRUSTED_PROXY` setting only)
  - the auth and guest limiters (`auth.allowPeer`, `auth.RequestLimiter`, the guest
    `limiter`)
  - `backend/migrations/00014_*.sql`
  - HOW_TO.md (a new "Deploy to AWS (development)" section)
  - README.md (one line)
- **Reused:**
  - `cmd/migrate` and its advisory lock
  - the role SQL in `infrastructure/postgres/init.sh` (adapted for RDS)
  - the release image and Dockerfile
  - the deploy journey and HTTPS browser group, run against a new base URL
  - the `CloudFront-Viewer-Address` and caching rules already written in MILESTONE_17.md

## Verification

- **Locally, every task:** `dev.sh check`, `integration --race`, the frontend unit tests,
  `test:e2e`, `test:e2e:https` and `deploy-verify`. The single-host mode must keep passing.
- **Terraform:** `terraform fmt -check`, `terraform validate`, and `tflint` if available.
  `terraform plan` with no AWS changes after an apply shows no drift.
- **AWS (task 5), run only with the user's go-ahead, because it costs money:**
  - `apply`, then curl the CloudFront URL's `/api/v1/products` and deep links.
  - The HTTPS browser group against the CloudFront URL.
  - The spoofing and lockdown checks.
  - `terraform destroy`, then confirm no tagged resources are left.

## Using the GitHub app and the GitHub MCP

- **Now:** I read `tf-networking`, `tf-ecs`, `tf-aws-account`, `tf-rds`, `tf-globals` and
  `tf-cloudfront` to match their conventions. I can keep reading them, for example the
  CloudFront function and the `tf-shared-actions` composite action, while writing the
  modules.
- **Later, if this repository goes to GitHub:**
  - Issues for each M17 task.
  - PRs that get a `terraform plan` comment through `tf-shared-actions` over OIDC.
  - `@claude` reviews through the GitHub app.

  Creating a repository or pushing is something I'd only do once you confirm.
