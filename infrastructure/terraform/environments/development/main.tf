# Commerce Reliability Lab, Milestone 17: AWS DEVELOPMENT stack.
#
#   Browser -HTTPS-> CloudFront --default--> S3 (OAC, SPA fallback function)
#                              \--/api/*--> VPC origin -> internal ALB (private subnets)
#                                            -HTTPS-> ECS tasks on EC2 (private) -verify-full-> RDS
#
# One root, one apply. Each module mirrors one of the layered tf-* repos;
# production would apply them as separate roots linked by remote state.

locals {
  name       = "${var.project}-${var.env}"
  source_dir = abspath("${path.root}/../../../..")

  # AZ IDs without CloudFront VPC origin support (CloudFront developer guide).
  vpc_origin_unsupported_zone_ids = {
    us-east-1      = ["use1-az3"]
    us-west-1      = ["usw1-az2"]
    ap-northeast-1 = ["apne1-az3"]
    ca-central-1   = ["cac1-az3"]
  }
  frontend_origin = (var.domain_name != null
    ? "https://shop.${var.domain_name}"
  : "https://${module.edge.distribution_domain_name}")

  # Where the db-bootstrap container writes the regional RDS CA bundle.
  rds_ca_path = "/shared/certs/rds-ca.pem"
}

module "network" {
  source = "../../modules/network"

  name     = local.name
  region   = var.region
  vpc_cidr = var.vpc_cidr

  exclude_zone_ids = lookup(local.vpc_origin_unsupported_zone_ids, var.region, [])
}

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  name               = local.name
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  instance_type      = var.instance_type
  min_size           = var.asg_min_size
  max_size           = var.asg_max_size
}

module "database" {
  source = "../../modules/database"

  name               = local.name
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  instance_class     = var.db_instance_class
  ca_bundle_path     = local.rds_ca_path

  client_security_group_ids = {
    api-tasks          = module.service.api_security_group_id
    container-instance = module.ecs_cluster.node_security_group_id
  }
}

module "service" {
  source = "../../modules/service"

  name                   = local.name
  region                 = var.region
  vpc_id                 = module.network.vpc_id
  private_subnet_ids     = module.network.private_subnet_ids
  cluster_id             = module.ecs_cluster.cluster_id
  capacity_provider_name = module.ecs_cluster.capacity_provider_name
  node_security_group_id = module.ecs_cluster.node_security_group_id

  database = {
    address           = module.database.address
    port              = module.database.port
    name              = module.database.database_name
    master_username   = module.database.master_username
    secret_arn        = module.database.secret_arn
    secret_version_id = module.database.secret_version_id
  }

  source_dir        = local.source_dir
  app_version       = var.app_version
  frontend_origin   = local.frontend_origin
  domain_name       = var.domain_name
  api_desired_count = var.api_desired_count
  postgres_image    = var.postgres_image
  mailpit_image     = var.mailpit_image
}

module "edge" {
  source = "../../modules/edge"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name        = local.name
  region      = var.region
  domain_name = var.domain_name

  api_origin_domain_name = module.service.origin_domain_name
  api_vpc_origin_id      = module.service.vpc_origin_id

  publish_spa      = var.publish_spa
  local_image_name = module.service.local_image_name
  image_digest     = module.service.image_digest
}
