variable "name" {
  type        = string
  description = "Resource name prefix, such as ecom-development"
}

variable "region" {
  type        = string
  description = "Region of the S3 bucket (for the publish step)"
}

variable "domain_name" {
  type        = string
  default     = null
  description = "Optional Route 53 zone; set gives shop.<domain> with an ACM certificate in us-east-1"
}

variable "api_origin_domain_name" {
  type        = string
  description = "ALB host for /api/* (origin.<domain>, or the internal ALB DNS name)"
}

variable "api_vpc_origin_id" {
  type        = string
  description = "CloudFront VPC origin for the internal ALB (protocol is set there)"
}

variable "publish_spa" {
  type        = bool
  default     = true
  description = "Run the local-exec step that uploads /app/dist (needs docker and the AWS CLI)"
}

variable "local_image_name" {
  type        = string
  description = "Local image to extract /app/dist from"
}

variable "api_rollout" {
  type        = string
  description = "The service module's api_rollout output; the SPA publish waits for it, so new assets go live only after the new API tasks serve"
}

variable "image_digest" {
  type        = string
  description = "Pushed image digest; a new digest republishes the SPA"
}
