# Internal ALB in the private subnets, reachable only through a CloudFront VPC
# origin. The ALB has no public address; CloudFront reaches it through
# service-managed ENIs in the private subnets. Its security group admits only
# CloudFront-VPCOrigins-Service-SG, which AWS creates with the first VPC origin
# in this VPC and which carries traffic only for this account's distributions.
# No shared origin secret is needed.
#
# domain_name set:   HTTPS :443 listener, ACM certificate for origin.<domain>
#                    and shop.<domain> (CloudFront forwards the viewer's Host).
# domain_name unset: HTTP :80 listener (CloudFront -> ALB in clear text over
#                    the AWS network, development only). The ALB always
#                    re-encrypts to the tasks.

locals {
  use_domain    = var.domain_name != null
  origin_fqdn   = local.use_domain ? "origin.${var.domain_name}" : null
  shop_fqdn     = local.use_domain ? "shop.${var.domain_name}" : null
  listener_mode = local.use_domain ? "https" : "http"
  listener_port = local.use_domain ? 443 : 80
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Internal ALB: ingress only from CloudFront VPC origins"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-alb"
  }
}

resource "aws_vpc_security_group_egress_rule" "alb_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "HTTPS to API tasks"
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  internal           = true
  subnets            = var.private_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  drop_invalid_header_fields = true
  idle_timeout               = 60
  enable_deletion_protection = false # development
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  vpc_id      = var.vpc_id
  target_type = "ip"
  protocol    = "HTTPS"
  port        = var.api_port

  deregistration_delay = 30

  health_check {
    protocol            = "HTTPS"
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# Switching domain modes changes the protocol. ELBv2 cannot turn an HTTPS
# listener into an HTTP one in place (the SSL policy stays set), and a VPC
# origin cannot be edited while a distribution uses it, so a mode change
# replaces both instead.
resource "terraform_data" "listener_mode" {
  input = local.listener_mode
}

resource "aws_lb_listener" "edge" {
  load_balancer_arn = aws_lb.this.arn
  port              = local.listener_port
  protocol          = local.use_domain ? "HTTPS" : "HTTP"
  ssl_policy        = local.use_domain ? "ELBSecurityPolicy-TLS13-1-2-2021-06" : null
  certificate_arn   = local.use_domain ? aws_acm_certificate_validation.origin[0].certificate_arn : null

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  lifecycle {
    replace_triggered_by = [terraform_data.listener_mode]
  }
}

# --- CloudFront VPC origin -----------------------------------------------------

# Takes up to ~15 minutes to deploy. The name carries the mode so a
# replacement can be created before the old one is removed.
resource "aws_cloudfront_vpc_origin" "api" {
  vpc_origin_endpoint_config {
    name                   = "${var.name}-api-${local.listener_mode}"
    arn                    = aws_lb.this.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "${local.listener_mode}-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  lifecycle {
    create_before_destroy = true
    replace_triggered_by  = [terraform_data.listener_mode]
  }
}

# Created by AWS with the first VPC origin in the VPC; read after it exists.
data "aws_security_group" "cloudfront_vpc_origins" {
  vpc_id = var.vpc_id

  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }

  depends_on = [aws_cloudfront_vpc_origin.api]
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront" {
  security_group_id            = aws_security_group.alb.id
  description                  = "CloudFront VPC origins (distributions in this account)"
  ip_protocol                  = "tcp"
  from_port                    = local.listener_port
  to_port                      = local.listener_port
  referenced_security_group_id = data.aws_security_group.cloudfront_vpc_origins.id
}

# --- Optional domain: origin.<domain> with a regional ACM certificate --------

data "aws_route53_zone" "this" {
  count = local.use_domain ? 1 : 0

  name         = var.domain_name
  private_zone = false
}

resource "aws_acm_certificate" "origin" {
  count = local.use_domain ? 1 : 0

  domain_name               = local.origin_fqdn
  subject_alternative_names = [local.shop_fqdn]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "origin_validation" {
  for_each = local.use_domain ? {
    for o in aws_acm_certificate.origin[0].domain_validation_options : o.domain_name => o
  } : {}

  zone_id         = data.aws_route53_zone.this[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "origin" {
  count = local.use_domain ? 1 : 0

  certificate_arn         = aws_acm_certificate.origin[0].arn
  validation_record_fqdns = [for r in aws_route53_record.origin_validation : r.fqdn]
}

# Public record for the internal ALB (it resolves to private addresses). It
# gives the origin a name its certificate covers; CloudFront routes by the
# VPC origin, not by this record.
resource "aws_route53_record" "origin" {
  count = local.use_domain ? 1 : 0

  zone_id = data.aws_route53_zone.this[0].zone_id
  name    = local.origin_fqdn
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = false
  }
}
