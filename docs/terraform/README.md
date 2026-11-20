# Terraform

The AWS development stack: CloudFront and S3 for the SPA, an internal ALB behind a CloudFront VPC origin, ECS on EC2 for the API, RDS PostgreSQL, scheduled recovery jobs, all from one `terraform apply`.

| Document | What it covers |
|---|---|
| [DESIGN.md](DESIGN.md) | Architecture, design choices and their trade-offs, what was proven on AWS, defects found by running it, how production would differ |
| [COST.md](COST.md) | Running cost, and why a NAT gateway instead of VPC interface endpoints |
| [infrastructure/terraform/README.md](../../infrastructure/terraform/README.md) | Operator guide: prerequisites, apply, verify, destroy, known limits |
