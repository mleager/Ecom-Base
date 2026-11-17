output "alb_dns_name" {
  description = "Internal ALB (resolves to private addresses)"
  value       = aws_lb.this.dns_name
}

output "origin_domain_name" {
  description = "Host CloudFront uses for the API origin"
  value       = local.use_domain ? aws_route53_record.origin[0].fqdn : aws_lb.this.dns_name
}

output "vpc_origin_id" {
  description = "CloudFront VPC origin for the internal ALB"
  value       = aws_cloudfront_vpc_origin.api.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "image" {
  description = "Image reference the tasks run, pinned by digest"
  value       = local.image
}

output "image_digest" {
  value = docker_registry_image.app.sha256_digest
}

output "local_image_name" {
  description = "Local tag of the built image (used to extract /app/dist)"
  value       = docker_image.app.name
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "api_task_definition_family" {
  value = aws_ecs_task_definition.api.family
}

output "api_security_group_id" {
  value = aws_security_group.api.id
}

output "mail_host" {
  value = local.mail_host
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "service_secret_arns" {
  value = { for k, s in aws_secretsmanager_secret.service : k => s.arn }
}

output "jobs_security_group_id" {
  value = aws_security_group.jobs.id
}

output "task_definitions" {
  description = "Task definition families: api, mail, db-bootstrap, migrate"
  value = {
    api          = aws_ecs_task_definition.api.family
    mail         = aws_ecs_task_definition.mail.family
    db-bootstrap = aws_ecs_task_definition.bootstrap.family
    migrate      = aws_ecs_task_definition.migrate.family
  }
}

output "one_off_task_env" {
  description = "Settings for files/run-task.sh, as shell exports (no secrets)"
  value       = join("\n", [for k, v in merge(local.run_task_env, { STARTED_BY = "run-task.sh", SECURITY_GROUPS = aws_security_group.api.id }) : "export ${k}=${v}"])
}

output "run_task_script" {
  value = local.run_task_script
}
