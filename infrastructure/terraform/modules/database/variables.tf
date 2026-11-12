variable "name" {
  type        = string
  description = "Resource name prefix, such as ecom-development"
}

variable "vpc_id" {
  type        = string
  description = "VPC for the database security group"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnets for the DB subnet group"
}

variable "client_security_group_ids" {
  type        = map(string)
  description = "Security groups allowed to reach PostgreSQL, keyed by a static label"
}

variable "engine_version" {
  type        = string
  default     = "16"
  description = "PostgreSQL major version; RDS picks the default minor"
}

variable "instance_class" {
  type        = string
  default     = "db.t4g.micro"
  description = "RDS instance class"
}

variable "database_name" {
  type        = string
  default     = "ecom"
  description = "Database created by RDS; owned by ecom_migrator after bootstrap"
}

variable "master_username" {
  type        = string
  default     = "ecom_admin"
  description = "RDS master user (rds_superuser); used only by the db-bootstrap container"
}

variable "ca_bundle_path" {
  type        = string
  description = "Path, inside the task, of the RDS CA bundle used for sslrootcert"
}
