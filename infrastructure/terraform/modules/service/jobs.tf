# One-off database jobs, each its own task definition and execution role:
#
#   db-bootstrap  roles and ownership, as the RDS master user (whose password
#                 RDS manages); runs when the database or the bootstrap code
#                 changes. The master password reaches only this task.
#   migrate       migrate up, as ecom_migrator; runs when the image changes,
#                 BEFORE the API service is updated (aws_ecs_service.api
#                 depends on it), so a failed migration stops the apply with
#                 the running tasks untouched.
#
# Because migrations now run while the previous release still serves, every
# migration must work with the previous release's code (expand, then
# contract in a later release; docs/DECISIONS.md).
#
# Terraform runs them with files/run-task.sh. With run_one_off_tasks = false
# it only registers the task definitions, and a pipeline runs the same script.

resource "aws_security_group" "jobs" {
  name        = "${var.name}-db-jobs"
  description = "One-off database jobs: PostgreSQL egress only"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-db-jobs"
  }
}

resource "aws_vpc_security_group_egress_rule" "jobs_db" {
  security_group_id            = aws_security_group.jobs.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = var.database.port
  to_port                      = var.database.port
  referenced_security_group_id = var.database.security_group_id
}

locals {
  job_log_options = merge(local.log_options, { "awslogs-stream-prefix" = "jobs" })
}

resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "${var.name}-db-bootstrap"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = 128
  memory                   = 128
  execution_role_arn       = aws_iam_role.execution["bootstrap"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "db-bootstrap"
    image     = local.image
    essential = true
    command   = ["db-bootstrap"]
    environment = [
      { name = "APP_ENV", value = "production" },
      { name = "DB_HOST", value = var.database.address },
      { name = "DB_PORT", value = tostring(var.database.port) },
      { name = "DB_NAME", value = var.database.name },
      { name = "DB_USER", value = var.database.master_username },
      { name = "DB_SSLROOTCERT", value = var.database.ca_bundle_path },
    ]
    secrets = [
      { name = "DB_PASSWORD", valueFrom = local.master_password },
      { name = "MIGRATOR_PASSWORD", valueFrom = local.role_secret.migrator.PASSWORD },
      { name = "APP_DB_PASSWORD", valueFrom = local.role_secret.app.PASSWORD },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options   = local.job_log_options
    }
  }])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = 128
  memory                   = 128
  execution_role_arn       = aws_iam_role.execution["migrate"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = local.image
    essential = true
    command   = ["migrate", "up"]
    environment = [
      { name = "APP_ENV", value = "production" },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.role_secret.migrator.DATABASE_URL },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options   = local.job_log_options
    }
  }])
}

locals {
  run_task_script = abspath("${path.module}/files/run-task.sh")
  run_task_env = {
    AWS_REGION        = var.region
    CLUSTER           = var.cluster_id
    SUBNETS           = join(",", var.private_subnet_ids)
    SECURITY_GROUPS   = aws_security_group.jobs.id
    CAPACITY_PROVIDER = var.capacity_provider_name
    LOG_GROUP         = aws_cloudwatch_log_group.this.name
    STARTED_BY        = "terraform"
  }

  # The bootstrap logic: a change to it re-runs the job.
  bootstrap_source_hash = sha1(join("", [for f in sort(fileset(var.source_dir, "backend/internal/dbbootstrapcmd/*.go")) : filesha1("${var.source_dir}/${f}")]))
}

resource "terraform_data" "bootstrap" {
  count = var.run_one_off_tasks ? 1 : 0

  # A new database, new role passwords or new bootstrap code.
  triggers_replace = [
    var.database.instance_resource_id,
    var.database.role_secrets.migrator.version_id,
    var.database.role_secrets.app.version_id,
    local.bootstrap_source_hash,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = "bash '${local.run_task_script}' '${aws_ecs_task_definition.bootstrap.arn}'"
    environment = local.run_task_env
  }

  depends_on = [
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy_attachment.execution,
    aws_vpc_security_group_egress_rule.jobs_db,
  ]
}

resource "terraform_data" "migrate" {
  count = var.run_one_off_tasks ? 1 : 0

  # A new image (new migrations), or a fresh bootstrap (a new database).
  triggers_replace = [
    local.image,
    terraform_data.bootstrap[0].id,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = "bash '${local.run_task_script}' '${aws_ecs_task_definition.migrate.arn}'"
    environment = local.run_task_env
  }
}
