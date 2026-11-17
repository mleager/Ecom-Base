# Mailpit: captures every message the API sends; nothing leaves AWS.
# One task in the private subnets, found by the API as mail.<name>.internal
# through Cloud Map. STARTTLS is required, with a certificate from tls.tf.
#
# UI: no load balancer. Forward port 8025 through a container instance with
# SSM Session Manager (README, "Read captured mail"; output mailpit_ui_command).

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = local.namespace
  description = "Internal service names for ${var.name}"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "mail" {
  name = "mail"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_security_group" "mail" {
  name        = "${var.name}-mail"
  description = "Mailpit: SMTP from API tasks, UI from container instances (SSM port forwarding); no egress"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-mail"
  }
}

resource "aws_vpc_security_group_ingress_rule" "mail_smtp" {
  security_group_id            = aws_security_group.mail.id
  description                  = "SMTP from API tasks"
  ip_protocol                  = "tcp"
  from_port                    = 1025
  to_port                      = 1025
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "mail_ui" {
  security_group_id            = aws_security_group.mail.id
  description                  = "Mailpit UI via SSM port forwarding on a container instance"
  ip_protocol                  = "tcp"
  from_port                    = 8025
  to_port                      = 8025
  referenced_security_group_id = var.node_security_group_id
}

resource "aws_ecs_task_definition" "mail" {
  family                   = "${var.name}-mail"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = 128
  memory                   = 192
  execution_role_arn       = aws_iam_role.execution["mail"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "mail-certs"
  }

  container_definitions = jsonencode([
    {
      # Writes the certificate and key as files owned by 65532, as the
      # Compose "certs" service does.
      name              = "mail-certs"
      image             = var.postgres_image
      essential         = false
      user              = "0:0"
      memoryReservation = 32
      entryPoint        = ["/bin/sh", "-ec"]
      command = [join(" && ", [
        "umask 077",
        "printf '%s\\n' \"$MAIL_TLS_CERT\" > /tmp/mail.pem",
        "printf '%s\\n' \"$MAIL_TLS_KEY\" > /tmp/mail.key",
        "install -o 65532 -g 65532 -m 0444 /tmp/mail.pem /certs/mail.pem",
        "install -o 65532 -g 65532 -m 0400 /tmp/mail.key /certs/mail.key",
        "rm -f /tmp/mail.key",
      ])]
      environment = [
        { name = "MAIL_TLS_CERT", value = tls_locally_signed_cert.mail.cert_pem },
      ]
      secrets = [
        { name = "MAIL_TLS_KEY", valueFrom = local.mail_secret.MAIL_TLS_KEY },
      ]
      mountPoints = [{ sourceVolume = "mail-certs", containerPath = "/certs", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options   = merge(local.log_options, { "awslogs-stream-prefix" = "mail" })
      }
    },
    {
      name              = "mailpit"
      image             = var.mailpit_image
      essential         = true
      user              = "65532:65532"
      memoryReservation = 64
      command = [
        "--smtp-tls-cert=/certs/mail.pem",
        "--smtp-tls-key=/certs/mail.key",
        "--smtp-require-starttls",
        "--smtp-auth-accept-any",
      ]
      portMappings = [
        { containerPort = 1025, protocol = "tcp" },
        { containerPort = 8025, protocol = "tcp" },
      ]
      mountPoints = [{ sourceVolume = "mail-certs", containerPath = "/certs", readOnly = true }]
      dependsOn   = [{ containerName = "mail-certs", condition = "SUCCESS" }]
      logConfiguration = {
        logDriver = "awslogs"
        options   = merge(local.log_options, { "awslogs-stream-prefix" = "mail" })
      }
    },
  ])
}

resource "aws_ecs_service" "mail" {
  name            = "${var.name}-mail"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.mail.arn
  desired_count   = 1

  # The execution role must be able to read the secrets before ECS places the
  # first task; otherwise the first launches fail and ECS backs off.
  depends_on = [aws_iam_role_policy.execution_secrets, aws_iam_role_policy_attachment.execution]

  # One instance only: stop the old task before starting the new one.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  capacity_provider_strategy {
    capacity_provider = var.capacity_provider_name
    base              = 1
    weight            = 100
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.mail.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.mail.arn
  }
}
