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

output "identifier" {
  value = aws_db_instance.this.identifier
}

output "secret_arn" {
  description = "Secrets Manager secret with JSON keys MASTER_PASSWORD, MIGRATOR_PASSWORD, APP_DB_PASSWORD, MIGRATE_DATABASE_URL, API_DATABASE_URL"
  value       = aws_secretsmanager_secret.database.arn
}

# Secret ARNs only resolve for ECS once a version exists.
output "secret_version_id" {
  value = aws_secretsmanager_secret_version.database.version_id
}
