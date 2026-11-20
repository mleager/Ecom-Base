variable "name" {
  type        = string
  description = "Cluster name and resource name prefix"
}

variable "vpc_id" {
  type        = string
  description = "VPC for the container instances"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnets for the Auto Scaling group"
}

variable "instance_type" {
  type        = string
  default     = "t3.small"
  description = "EC2 instance type for container instances (x86_64; the image is built for linux/amd64)"
}

variable "ecs_ami_id" {
  type        = string
  default     = null
  description = "Pin the container instance AMI (an ECS-optimized AL2023 x86_64 image ID); null follows AWS's recommended AMI"

  validation {
    condition     = var.ecs_ami_id == null || can(regex("^ami-[0-9a-f]{8,17}$", var.ecs_ami_id))
    error_message = "ecs_ami_id must be null or an AMI ID such as ami-0123456789abcdef0."
  }
}

variable "min_size" {
  type        = number
  default     = 2
  description = "Minimum (and initial) number of container instances"
}

variable "max_size" {
  type        = number
  default     = 3
  description = "Maximum number of container instances (room for a rolling deploy)"
}
