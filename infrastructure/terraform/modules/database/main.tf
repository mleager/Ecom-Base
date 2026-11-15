# Data layer (mirrors tf-rds): RDS PostgreSQL 16, single AZ, private subnets
# only, TLS forced, and the three role passwords in Secrets Manager.
#
# Development only: single AZ, no deletion protection, no final snapshot,
# 1-day backups. Production would be Multi-AZ with deletion protection, a final
# snapshot and longer retention.

resource "random_password" "master" {
  length  = 40
  special = false
}

resource "random_password" "migrator" {
  length  = 40
  special = false
}

resource "random_password" "app" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "PostgreSQL: ingress only from ECS tasks and container instances"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-db"
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_clients" {
  for_each = var.client_security_group_ids

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres16"
  family = "postgres16"

  # Reject any non-TLS connection (the default on 16, set explicitly).
  # RDS records both as pending-reboot; matching it keeps plans drift-free.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "ssl_min_protocol_version"
    value        = "TLSv1.2"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = var.database_name
  username = var.master_username
  password = random_password.master.result
  port     = 5432

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = 1
  auto_minor_version_upgrade = true
  apply_immediately          = true

  # Development only.
  deletion_protection = false
  skip_final_snapshot = true
}

locals {
  # Hex/alphanumeric passwords need no URL encoding. The CA bundle path is
  # where the db-bootstrap init container writes the regional RDS bundle.
  url_options = "sslmode=verify-full&sslrootcert=${var.ca_bundle_path}"
  db_address  = aws_db_instance.this.address
}

resource "aws_secretsmanager_secret" "database" {
  name                    = "${var.name}/database"
  description             = "PostgreSQL credentials and connection URLs (development stack)"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "database" {
  secret_id = aws_secretsmanager_secret.database.id
  secret_string = jsonencode({
    MASTER_PASSWORD      = random_password.master.result
    MIGRATOR_PASSWORD    = random_password.migrator.result
    APP_DB_PASSWORD      = random_password.app.result
    MIGRATE_DATABASE_URL = "postgresql://ecom_migrator:${random_password.migrator.result}@${local.db_address}:5432/${var.database_name}?${local.url_options}"
    API_DATABASE_URL     = "postgresql://ecom_app:${random_password.app.result}@${local.db_address}:5432/${var.database_name}?${local.url_options}"
  })
}
