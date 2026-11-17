variable "name" {
  type        = string
  description = "Name prefix for network resources, such as ecom-development"
}

variable "region" {
  type        = string
  description = "AWS region, used for the S3 gateway endpoint service name"
}

variable "vpc_cidr" {
  type        = string
  default     = "10.40.0.0/16"
  description = "VPC CIDR block; subnets are /24s carved from it"
}

variable "exclude_zone_ids" {
  type        = list(string)
  default     = []
  description = "AZ IDs to skip, such as use1-az3 (no CloudFront VPC origin support)"
}
