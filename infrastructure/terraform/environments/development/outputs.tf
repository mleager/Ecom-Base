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
  description = "Internal ALB: resolves to private addresses, unreachable from the internet"
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

output "ecs_ami_id" {
  description = "AMI the container instances use; copy it to ecs_ami_id to pin it"
  value       = module.ecs_cluster.ecs_ami_id
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

output "database_master_secret_arn" {
  description = "RDS-managed master secret; read only by the db-bootstrap task"
  value       = module.database.master_secret_arn
}

output "service_secret_arns" {
  value = module.service.service_secret_arns
}

output "task_definitions" {
  value = module.service.task_definitions
}

output "one_off_task_env" {
  description = "eval this, then run run_task_script (README, \"Run a one-off task\")"
  value       = module.service.one_off_task_env
}

output "run_task_script" {
  value = module.service.run_task_script
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

output "job_schedule_name" {
  description = "EventBridge Scheduler schedule for reconcile and maintain (README, \"Scheduled jobs\")"
  value       = module.service.job_schedule_name
}

output "job_alert_topic_arn" {
  description = "SNS topic for failed scheduled jobs"
  value       = module.service.job_alert_topic_arn
}
