# Edge layer (mirrors tf-cloudfront, with OAC instead of OAI): one CloudFront
# distribution, one browser origin.
#   default  -> private S3 bucket (dist/) via Origin Access Control,
#               SPA fallback CloudFront Function, cache from object metadata
#   /api/*   -> the ALB, uncached, all methods, secret origin header
#
# domain_name set:   aliases shop.<domain>, ACM certificate in us-east-1.
# domain_name unset: the *.cloudfront.net name and default certificate.

locals {
  use_domain = var.domain_name != null
  shop_fqdn  = local.use_domain ? "shop.${var.domain_name}" : null

  s3_origin_id  = "spa-s3"
  api_origin_id = "api-alb"
}

# --- S3 bucket: private, reachable only through OAC --------------------------

resource "aws_s3_bucket" "spa" {
  bucket_prefix = "${var.name}-spa-"
  force_destroy = true # development: destroy empties the bucket
}

resource "aws_s3_bucket_public_access_block" "spa" {
  bucket                  = aws_s3_bucket.spa.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "spa" {
  bucket = aws_s3_bucket.spa.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "spa" {
  bucket = aws_s3_bucket.spa.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "${var.name}-spa"
  description                       = "CloudFront access to the SPA bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "spa" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.spa.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "spa" {
  bucket = aws_s3_bucket.spa.id
  policy = data.aws_iam_policy_document.spa.json

  depends_on = [aws_s3_bucket_public_access_block.spa]
}

# --- Function and policies ---------------------------------------------------

resource "aws_cloudfront_function" "spa_fallback" {
  name    = "${var.name}-spa-fallback"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite extensionless paths to /index.html"
  publish = true
  code    = file("${path.module}/files/spa-fallback.js")
}

# Honours the Cache-Control set on each object at upload (immutable assets,
# 1h fixtures, no-cache HTML); min 0 so no-cache really revalidates.
resource "aws_cloudfront_cache_policy" "spa" {
  name        = "${var.name}-spa"
  comment     = "SPA: TTL from object Cache-Control"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Everything the API reads from the viewer: Origin and X-CSRF-Protection
# (CSRF check), Idempotency-Key (checkout), cookies (session), all query
# strings, and CloudFront-Viewer-Address (client IP, TRUSTED_PROXY=cloudfront).
# Host is not forwarded; the ALB sees its own name.
resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "${var.name}-api"
  comment = "API: viewer Origin, CSRF, idempotency, cookies, query, viewer address"

  cookies_config {
    cookie_behavior = "all"
  }

  headers_config {
    header_behavior = "whitelist"

    headers {
      items = [
        "Accept",
        "CloudFront-Viewer-Address",
        "Content-Type",
        "Idempotency-Key",
        "Origin",
        "X-CSRF-Protection",
      ]
    }
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

# Static responses: HSTS and nosniff on everything, plus the HTML headers.
# A response headers policy cannot match on content type, so Referrer-Policy
# and X-Frame-Options also go on assets and fixtures, where they are harmless.
resource "aws_cloudfront_response_headers_policy" "spa" {
  name    = "${var.name}-spa"
  comment = "HSTS, nosniff, no-referrer, DENY framing"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

# API responses: HSTS and nosniff; Set-Cookie and the API's own headers pass
# through unchanged.
resource "aws_cloudfront_response_headers_policy" "api" {
  name    = "${var.name}-api"
  comment = "HSTS and nosniff"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }
  }
}

# --- Distribution ------------------------------------------------------------

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = "${var.name} (development only)"
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = "PriceClass_100"
  default_root_object = "index.html"
  aliases             = local.use_domain ? [local.shop_fqdn] : []

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.spa.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }

  origin {
    origin_id   = local.api_origin_id
    domain_name = var.api_origin_domain_name

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = var.api_origin_protocol_policy
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 30
      origin_keepalive_timeout = 5
    }

    # Overwrites any viewer-supplied header of the same name.
    custom_header {
      name  = var.origin_verify_header_name
      value = var.origin_verify_secret
    }
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.spa.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.spa.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_fallback.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = local.api_origin_id
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.use_domain
    acm_certificate_arn            = local.use_domain ? aws_acm_certificate_validation.shop[0].certificate_arn : null
    ssl_support_method             = local.use_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}

# --- Optional domain: shop.<domain>, certificate in us-east-1 ----------------

data "aws_route53_zone" "this" {
  count = local.use_domain ? 1 : 0

  name         = var.domain_name
  private_zone = false
}

resource "aws_acm_certificate" "shop" {
  count    = local.use_domain ? 1 : 0
  provider = aws.us_east_1

  domain_name       = local.shop_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "shop_validation" {
  for_each = local.use_domain ? {
    for o in aws_acm_certificate.shop[0].domain_validation_options : o.domain_name => o
  } : {}

  zone_id         = data.aws_route53_zone.this[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "shop" {
  count    = local.use_domain ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.shop[0].arn
  validation_record_fqdns = [for r in aws_route53_record.shop_validation : r.fqdn]
}

resource "aws_route53_record" "shop" {
  for_each = local.use_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = data.aws_route53_zone.this[0].zone_id
  name    = local.shop_fqdn
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}

# --- Publish the SPA from the release image ----------------------------------

resource "terraform_data" "publish_spa" {
  count = var.publish_spa ? 1 : 0

  triggers_replace = [
    var.image_digest,
    aws_s3_bucket.spa.id,
    aws_cloudfront_distribution.this.id,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = "bash '${abspath(path.module)}/files/publish-spa.sh'"

    environment = {
      IMAGE           = var.local_image_name
      BUCKET          = aws_s3_bucket.spa.id
      DISTRIBUTION_ID = aws_cloudfront_distribution.this.id
      AWS_REGION      = var.region
    }
  }

  depends_on = [aws_s3_bucket_policy.spa]
}
