output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "origin_domain_name" {
  description = "Host CloudFront uses for the API origin"
  value       = local.use_domain ? aws_route53_record.origin[0].fqdn : aws_lb.this.dns_name
}

output "origin_protocol_policy" {
  value = local.use_domain ? "https-only" : "http-only"
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

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}
