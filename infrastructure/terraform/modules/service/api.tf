# API service: N tasks on the EC2 capacity provider, awsvpc, registered by IP.
#
# Each task chains three containers with dependsOn:
#   db-bootstrap (exit 0) -> migrate up (exit 0) -> api
# so the schema is current before a task can receive traffic. migrate's
# advisory lock makes concurrent tasks safe. Production would run migrations
# as a separate one-off task before the deploy instead.

locals {
  namespace = "${var.name}.internal"
  mail_host = "mail.${local.namespace}"

  shared_volume = "shared"
  certs_dir     = "/shared/certs"

  log_options = {
    "awslogs-group"         = aws_cloudwatch_log_group.this.name
    "awslogs-region"        = var.region
    "awslogs-stream-prefix" = "api"
  }

  rds_ca_bundle_url = "https://truststore.pki.rds.amazonaws.com/${var.region}/${var.region}-bundle.pem"
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = 7
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "API tasks: HTTPS from the ALB only"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-api"
  }
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "HTTPS from the ALB"
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  referenced_security_group_id = aws_security_group.alb.id
}

# PostgreSQL, Mailpit and HTTPS (RDS CA bundle download) via the NAT gateway.
resource "aws_vpc_security_group_egress_rule" "api_all" {
  security_group_id = aws_security_group.api.id
  description       = "RDS, Mailpit and HTTPS egress"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # Task-scoped Docker volume, empty at start, removed with the task.
  volume {
    name = local.shared_volume
  }

  container_definitions = jsonencode([
    {
      name              = "db-bootstrap"
      image             = var.postgres_image
      essential         = false
      user              = "0:0"
      memoryReservation = 64
      entryPoint        = ["/bin/sh", "-ec"]
      command           = [file("${path.module}/files/db-bootstrap.sh")]
      environment = [
        { name = "DB_HOST", value = var.database.address },
        { name = "DB_PORT", value = tostring(var.database.port) },
        { name = "DB_NAME", value = var.database.name },
        { name = "DB_MASTER_USER", value = var.database.master_username },
        { name = "RDS_CA_BUNDLE_URL", value = local.rds_ca_bundle_url },
        { name = "API_TLS_CERT", value = tls_locally_signed_cert.api.cert_pem },
        { name = "MAIL_CA_CERT", value = tls_self_signed_cert.ca.cert_pem },
      ]
      secrets = [
        { name = "MASTER_PASSWORD", valueFrom = local.db_secret.MASTER_PASSWORD },
        { name = "MIGRATOR_PASSWORD", valueFrom = local.db_secret.MIGRATOR_PASSWORD },
        { name = "APP_DB_PASSWORD", valueFrom = local.db_secret.APP_DB_PASSWORD },
        { name = "API_TLS_KEY", valueFrom = local.app_secret.API_TLS_KEY },
      ]
      mountPoints = [{ sourceVolume = local.shared_volume, containerPath = "/shared", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options   = local.log_options
      }
    },
    {
      name              = "migrate"
      image             = local.image
      essential         = false
      memoryReservation = 64
      command           = ["migrate", "up"]
      environment = [
        { name = "APP_ENV", value = "production" },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = local.db_secret.MIGRATE_DATABASE_URL },
      ]
      mountPoints = [{ sourceVolume = local.shared_volume, containerPath = "/shared", readOnly = true }]
      dependsOn   = [{ containerName = "db-bootstrap", condition = "SUCCESS" }]
      logConfiguration = {
        logDriver = "awslogs"
        options   = local.log_options
      }
    },
    {
      name              = "api"
      image             = local.image
      essential         = true
      memoryReservation = 128
      command           = ["api"]
      portMappings      = [{ containerPort = var.api_port, protocol = "tcp", appProtocol = "http" }]
      environment = [
        { name = "APP_ENV", value = "production" },
        { name = "HTTP_ADDR", value = "0.0.0.0:${var.api_port}" },
        { name = "FRONTEND_ORIGIN", value = var.frontend_origin },
        { name = "TLS_CERT_FILE", value = "${local.certs_dir}/server.pem" },
        { name = "TLS_KEY_FILE", value = "${local.certs_dir}/server.key" },
        # CloudFront and S3 serve the SPA; the API serves only /api and /health.
        { name = "STATIC_DIR", value = "" },
        # Client IP from CloudFront-Viewer-Address (MILESTONE_17.md).
        { name = "TRUSTED_PROXY", value = "cloudfront" },
        # Request limits shared by every API task (migration 14).
        { name = "RATE_LIMIT_STORE", value = "postgres" },
        { name = "MAIL_MODE", value = "smtp" },
        { name = "SMTP_HOST", value = local.mail_host },
        { name = "SMTP_PORT", value = "1025" },
        { name = "SMTP_TLS_MODE", value = "starttls" },
        { name = "SMTP_USERNAME", value = "ecom" },
        { name = "MAIL_FROM", value = var.mail_from },
        # Replaces the system roots: the only outbound TLS (besides PostgreSQL,
        # which uses sslrootcert) is SMTP to Mailpit.
        { name = "SSL_CERT_FILE", value = "${local.certs_dir}/mail-ca.pem" },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = local.db_secret.API_DATABASE_URL },
        { name = "JWT_SECRET_BASE64", valueFrom = local.app_secret.JWT_SECRET_BASE64 },
        { name = "SMTP_PASSWORD", valueFrom = local.app_secret.SMTP_PASSWORD },
      ]
      mountPoints = [{ sourceVolume = local.shared_volume, containerPath = "/shared", readOnly = true }]
      dependsOn   = [{ containerName = "migrate", condition = "SUCCESS" }]
      stopTimeout = 30
      logConfiguration = {
        logDriver = "awslogs"
        options   = local.log_options
      }
    },
  ])
}

resource "aws_ecs_service" "api" {
  name            = "${var.name}-api"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 120
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  capacity_provider_strategy {
    capacity_provider = var.capacity_provider_name
    base              = 1
    weight            = 100
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.api_port
  }

  # Mail must resolve before the API sends its first message.
  depends_on = [aws_lb_listener_rule.from_cloudfront, aws_ecs_service.mail]
}
