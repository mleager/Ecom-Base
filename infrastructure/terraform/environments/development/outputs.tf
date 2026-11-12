# No secrets here. Secret values live in Secrets Manager (and in state).

output "site_url" {
  description = "The one browser origin (FRONTEND_ORIGIN)"
  value       = local.frontend_origin
}

output "cloudfront_distribution_id" {
  value = module.edge.distribution_id
}

output "cloudfront_domain_name" {
  value = module.edge.distribution_domain_name
}

output "spa_bucket" {
  value = module.edge.bucket_name
}

output "alb_dns_name" {
  description = "Direct requests here must get 403 (no secret header) or time out (not CloudFront)"
  value       = module.service.alb_dns_name
}

output "image" {
  description = "Image the API tasks run, pinned by digest"
  value       = module.service.image
}

output "ecs_cluster_name" {
  value = module.ecs_cluster.cluster_name
}

output "api_service_name" {
  value = module.service.api_service_name
}

output "api_task_definition_family" {
  value = module.service.api_task_definition_family
}

output "rds_identifier" {
  value = module.database.identifier
}

output "log_group_name" {
  value = module.service.log_group_name
}

output "database_secret_arn" {
  value = module.database.secret_arn
}

output "app_secret_arn" {
  value = module.service.app_secret_arn
}

output "mailpit_ui_command" {
  description = "Forward the Mailpit UI to http://localhost:8025 through a container instance (SSM)"
  value       = <<-EOT
    instance_id=$(aws ec2 describe-instances --region ${var.region} \
      --filters Name=tag:aws:autoscaling:groupName,Values=${module.ecs_cluster.autoscaling_group_name} Name=instance-state-name,Values=running \
      --query 'Reservations[0].Instances[0].InstanceId' --output text)
    aws ssm start-session --region ${var.region} --target "$instance_id" \
      --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters 'host=${module.service.mail_host},portNumber=8025,localPortNumber=8025'
  EOT
}
