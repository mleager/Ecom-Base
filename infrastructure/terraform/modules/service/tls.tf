# Internal TLS, issued by Terraform (tls provider). Not publicly trusted and
# never seen by a browser:
# - api:  the ALB re-encrypts to the tasks on 8443 (ALB does not verify target
#         certificates), so the API keeps its production TLS requirement.
# - mail: Mailpit's STARTTLS certificate; the API verifies it with the CA via
#         SSL_CERT_FILE, as in the Compose deployment.

resource "tls_private_key" "ca" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 24 * 365
  early_renewal_hours   = 24 * 30

  subject {
    common_name  = "${var.name} internal CA"
    organization = "Commerce Reliability Lab (development)"
  }

  allowed_uses = ["cert_signing", "crl_signing", "digital_signature"]
}

resource "tls_private_key" "api" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "api" {
  private_key_pem = tls_private_key.api.private_key_pem
  dns_names       = ["api.${local.namespace}"]

  subject {
    common_name = "api.${local.namespace}"
  }
}

resource "tls_locally_signed_cert" "api" {
  cert_request_pem      = tls_cert_request.api.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 24 * 90
  early_renewal_hours   = 24 * 14
  allowed_uses          = ["digital_signature", "key_encipherment", "server_auth"]
}

resource "tls_private_key" "mail" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "mail" {
  private_key_pem = tls_private_key.mail.private_key_pem
  dns_names       = [local.mail_host]

  subject {
    common_name = local.mail_host
  }
}

resource "tls_locally_signed_cert" "mail" {
  cert_request_pem      = tls_cert_request.mail.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 24 * 90
  early_renewal_hours   = 24 * 14
  allowed_uses          = ["digital_signature", "key_encipherment", "server_auth"]
}
