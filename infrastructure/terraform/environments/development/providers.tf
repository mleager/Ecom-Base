terraform {
  # State is local by default so a reviewer needs no state bucket. To use the
  # S3 backend instead, copy backend.s3.tf.example to backend.s3.tf.
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.70.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "4.4.2"
    }
    docker = {
      source  = "kreuzwerker/docker"
      version = "4.6.0"
    }
  }
  required_version = "~> 1.12"
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.env
    }
  }
}

# CloudFront certificates must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.env
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_ecr_authorization_token" "this" {}

# Builds with the local Docker daemon and pushes to this account's ECR.
provider "docker" {
  registry_auth {
    address  = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    username = data.aws_ecr_authorization_token.this.user_name
    password = data.aws_ecr_authorization_token.this.password
  }
}
