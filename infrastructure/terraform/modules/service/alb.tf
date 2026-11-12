# Internet-facing ALB, reachable only from CloudFront:
# 1. its security group admits only the AWS-managed CloudFront origin-facing
#    prefix list, on the one listener port;
# 2. the listener's default action is 403; only requests carrying the secret
#    origin header (set by CloudFront) are forwarded.
#
# domain_name set:   HTTPS :443 listener, ACM certificate for origin.<domain>.
# domain_name unset: HTTP :80 listener (CloudFront -> ALB in clear text,
#                    development only). The ALB always re-encrypts to tasks.

locals {
  use_domain    = var.domain_name != null
  origin_fqdn   = local.use_domain ? "origin.${var.domain_name}" : null
  listener_port = local.use_domain ? 443 : 80
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "ALB: ingress only from CloudFront origin-facing addresses"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "CloudFront origin-facing prefix list"
  ip_protocol       = "tcp"
  from_port         = local.listener_port
  to_port           = local.listener_port
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
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
  internal           = false
  subnets            = var.public_subnet_ids
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

resource "aws_lb_listener" "edge" {
  load_balancer_arn = aws_lb.this.arn
  port              = local.listener_port
  protocol          = local.use_domain ? "HTTPS" : "HTTP"
  ssl_policy        = local.use_domain ? "ELBSecurityPolicy-TLS13-1-2-2021-06" : null
  certificate_arn   = local.use_domain ? aws_acm_certificate_validation.origin[0].certificate_arn : null

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.edge.arn
  priority     = 10

  condition {
    http_header {
      http_header_name = var.origin_verify_header_name
      values           = [var.origin_verify_secret]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# --- Optional domain: origin.<domain> with a regional ACM certificate --------

data "aws_route53_zone" "this" {
  count = local.use_domain ? 1 : 0

  name         = var.domain_name
  private_zone = false
}

resource "aws_acm_certificate" "origin" {
  count = local.use_domain ? 1 : 0

  domain_name       = local.origin_fqdn
  validation_method = "DNS"

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
