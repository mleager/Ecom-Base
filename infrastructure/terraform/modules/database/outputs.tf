output "address" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "database_name" {
  value = aws_db_instance.this.db_name
}

output "master_username" {
  value = aws_db_instance.this.username
}

output "instance_resource_id" {
  description = "Stable for the life of the instance; a replacement re-runs db-bootstrap"
  value       = aws_db_instance.this.resource_id
}

output "ca_bundle_path" {
  value = var.ca_bundle_path
}

output "identifier" {
  value = aws_db_instance.this.identifier
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "master_secret_arn" {
  description = "RDS-managed master secret (JSON keys username, password); rotated by RDS"
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

# Secret ARNs only resolve for ECS once a version exists, so these carry the
# version: "<arn>:<key>::<version>" pins a task definition to one value.
output "role_secrets" {
  description = "Per-role secrets (migrator, app), each with JSON keys PASSWORD and DATABASE_URL"
  value = { for k, s in aws_secretsmanager_secret.role : k => {
    arn        = s.arn
    version_id = aws_secretsmanager_secret_version.role[k].version_id
  } }
}
