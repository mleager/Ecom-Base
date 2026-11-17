variable "name" {
  type        = string
  description = "Resource name prefix, such as ecom-development"
}

variable "region" {
  type        = string
  description = "AWS region (log driver and RDS CA bundle)"
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Subnets for the tasks and the internal ALB"
}

variable "cluster_id" {
  type = string
}

variable "capacity_provider_name" {
  type = string
}

variable "node_security_group_id" {
  type        = string
  description = "Container instance security group, allowed to reach the Mailpit UI"
}

variable "database" {
  type = object({
    address              = string
    port                 = number
    name                 = string
    master_username      = string
    master_secret_arn    = string
    instance_resource_id = string
    security_group_id    = string
    ca_bundle_path       = string
    role_secrets = object({
      migrator = object({ arn = string, version_id = string })
      app      = object({ arn = string, version_id = string })
    })
  })
  description = "Connection details, the RDS-managed master secret and the per-role secrets from the database module"
}

variable "run_one_off_tasks" {
  type        = bool
  default     = true
  description = "Run db-bootstrap and migrate during apply (files/run-task.sh). Set false when a pipeline runs them."
}

variable "source_dir" {
  type        = string
  description = "Repository root: the Docker build context"
}

variable "app_version" {
  type        = string
  description = "Image VERSION build arg and tag prefix"
}

variable "frontend_origin" {
  type        = string
  description = "The single browser origin (https://shop.<domain> or https://<id>.cloudfront.net)"
}

variable "domain_name" {
  type        = string
  default     = null
  description = "Optional Route 53 zone; set gives origin.<domain> with a regional ACM certificate and an HTTPS listener"
}

variable "api_port" {
  type    = number
  default = 8443
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_cpu" {
  type    = number
  default = 256
}

variable "api_memory" {
  type    = number
  default = 512
}

variable "mail_from" {
  type    = string
  default = "no-reply@example.test"
}

variable "postgres_image" {
  type        = string
  description = "Pinned postgres:16-alpine (certs and mail-certs init containers)"
}

variable "mailpit_image" {
  type        = string
  description = "Pinned axllent/mailpit"
}
