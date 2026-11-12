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

variable "public_subnet_ids" {
  type        = list(string)
  description = "Subnets for the internet-facing ALB"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Subnets for the tasks"
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
    address           = string
    port              = number
    name              = string
    master_username   = string
    secret_arn        = string
    secret_version_id = string
  })
  description = "Connection details and the credentials secret from the database module"
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

variable "origin_verify_header_name" {
  type        = string
  description = "Header CloudFront adds to every origin request"
}

variable "origin_verify_secret" {
  type        = string
  sensitive   = true
  description = "Value of the origin header; requests without it get 403"
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
  description = "Pinned postgres:16-alpine (db-bootstrap and mail-certs init containers)"
}

variable "mailpit_image" {
  type        = string
  description = "Pinned axllent/mailpit"
}
