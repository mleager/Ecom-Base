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
