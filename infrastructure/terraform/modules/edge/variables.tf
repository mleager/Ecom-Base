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
  description = "ALB host for /api/* (origin.<domain>, or the ALB DNS name)"
}

variable "api_origin_protocol_policy" {
  type        = string
  description = "https-only with a domain, http-only without one"

  validation {
    condition     = contains(["https-only", "http-only"], var.api_origin_protocol_policy)
    error_message = "api_origin_protocol_policy must be https-only or http-only."
  }
}

variable "origin_verify_header_name" {
  type = string
}

variable "origin_verify_secret" {
  type      = string
  sensitive = true
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

variable "image_digest" {
  type        = string
  description = "Pushed image digest; a new digest republishes the SPA"
}
