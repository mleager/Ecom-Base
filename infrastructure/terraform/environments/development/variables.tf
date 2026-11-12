variable "project" {
  type        = string
  default     = "ecom"
  description = "Project name (default tag and resource name prefix)"
}

variable "env" {
  type        = string
  default     = "development"
  description = "Environment name. This root is development only."

  validation {
    condition     = var.env == "development"
    error_message = "This root is development only; production would use separate layered roots (README)."
  }
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region for everything except the CloudFront certificate (always us-east-1)"
}

variable "domain_name" {
  type        = string
  default     = null
  description = <<-EOT
    Optional existing public Route 53 hosted zone, such as example.com. Set:
    https://shop.<domain> (ACM in us-east-1) and origin.<domain> for the ALB
    (regional ACM, CloudFront -> ALB over HTTPS). Unset (null): the
    *.cloudfront.net address and CloudFront -> ALB over HTTP. The zone is only
    looked up, never created or destroyed here.
  EOT
}

variable "vpc_cidr" {
  type        = string
  default     = "10.40.0.0/16"
  description = "VPC CIDR block"
}

variable "instance_type" {
  type        = string
  default     = "t3.small"
  description = "ECS container instance type (x86_64)"
}

variable "asg_min_size" {
  type        = number
  default     = 2
  description = "Minimum container instances (2 task ENIs each on t3.small)"
}

variable "asg_max_size" {
  type        = number
  default     = 3
  description = "Maximum container instances (room for a rolling deploy)"
}

variable "db_instance_class" {
  type        = string
  default     = "db.t4g.micro"
  description = "RDS instance class"
}

variable "api_desired_count" {
  type        = number
  default     = 2
  description = "Number of API tasks behind the ALB"

  validation {
    condition     = var.api_desired_count >= 2
    error_message = "M17 runs at least 2 API tasks."
  }
}

variable "app_version" {
  type        = string
  default     = "1.1.0-dev"
  description = "Image VERSION label and tag prefix"
}

variable "publish_spa" {
  type        = bool
  default     = true
  description = "Upload /app/dist from the image to S3 during apply (needs docker and the AWS CLI)"
}

variable "postgres_image" {
  type        = string
  default     = "postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab"
  description = "Init-container image, the same digest as compose.deploy.yaml"
}

variable "mailpit_image" {
  type        = string
  default     = "axllent/mailpit:v1.32.0@sha256:0790692be935ea4420d085694f7985b1f692ca6a8771ab0e0bd8ba75ac180498"
  description = "Mailpit image, the same digest as compose.deploy.yaml"
}
