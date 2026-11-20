# AWS development stack: cost

On-demand list prices for `us-east-1`, before the free tier, Savings Plans and tax. The design is in [DESIGN.md](DESIGN.md). The stack is meant to run for a session and then be destroyed: a full verification run of about 70 minutes cost well under $1.

## Running cost

A month is 730 hours. Check the AWS pricing pages before you rely on these figures.

| Item | Unit price | Per day | Per month |
| --- | --- | --- | --- |
| NAT gateway | $0.045/hour + $0.045/GB processed | $1.08 | $32.85 |
| Public IPv4 address (NAT gateway only) | $0.005/hour | $0.12 | $3.65 |
| 2 × `t3.small` (3 during a rolling deploy) | $0.0208/hour each | $1.00 | $30.37 |
| 2 × 30 GB gp3 root volumes | $0.08/GB-month | $0.16 | $4.80 |
| Internal ALB | $0.0225/hour + LCUs (near zero at development traffic) | $0.54 | $16.43 |
| RDS `db.t4g.micro` | $0.016/hour | $0.38 | $11.68 |
| RDS 20 GB gp3 storage | $0.115/GB-month | $0.08 | $2.30 |
| Secrets Manager, CloudWatch Logs, S3, CloudFront, ECR, Scheduler, SNS, one alarm | usage | < $0.20 | < $6 |
| CloudFront VPC origin | no charge | – | – |
| **Total** | | **≈ $3.50** | **≈ $107** |

## Decision: a NAT gateway, not VPC interface endpoints

The container instances need to reach AWS APIs. There are two ways to give
private subnets that access:

- **NAT gateway:** one managed gateway forwards all outbound traffic to the
  internet, including AWS public endpoints.
- **VPC interface endpoints (PrivateLink):** one endpoint per AWS service,
  each with a network interface in every subnet AZ, so traffic to that
  service never leaves the VPC.

### Endpoints this stack would need

To run without a NAT gateway, the stack would need these interface endpoints,
each in both AZs:

| Endpoint | Used for |
| --- | --- |
| `ecs`, `ecs-agent`, `ecs-telemetry` | ECS agent registration, task state and metrics |
| `ecr.api`, `ecr.dkr` | Image authorization and manifests (layers already go through the free S3 gateway endpoint) |
| `logs` | `awslogs` log delivery |
| `secretsmanager` | Secrets injected into task definitions |
| `ssm`, `ssmmessages`, `ec2messages` | Session Manager and the Mailpit port forwarding |

That is **10 interface endpoints × 2 AZs = 20 endpoint network interfaces**.

The `certs` and `mail-certs` init containers and Mailpit pull
`postgres:16-alpine` and `axllent/mailpit` from **Docker Hub**. Without a NAT
gateway they would also need an ECR pull-through cache rule. Docker Hub
requires credentials in Secrets Manager for that, so the change is more than
just endpoints.

### Cost comparison

An interface endpoint costs $0.01 per hour per AZ, plus $0.01 per GB
processed. For 20 endpoint network interfaces that's $4.80 a day, or
$146 a month.

| Option | Network access per day | Stack per day | Stack per month | Compared with now |
| --- | --- | --- | --- | --- |
| **One NAT gateway (chosen)** | $1.20 | **$3.50** | **$107** | 1× |
| 10 endpoints in 2 AZs, no NAT gateway | $4.80 | $7.10 | $216 | about 2× |
| 10 endpoints in 2 AZs, NAT gateway kept for Docker Hub and anything else | $6.00 | $8.30 | $253 | about 2.4× |
| 13 endpoints in 2 AZs (adding `sts`, `kms` and `monitoring`), NAT gateway kept | $7.44 | $9.74 | $296 | about 2.8× |
| 10 endpoints in 1 AZ only, no NAT gateway | $2.40 | $4.70 | $143 | about 1.3×, and it adds cross-AZ data charges and a single-AZ dependency |

Endpoints would make the **network access line 4–6 times higher** and the
**whole stack 2–3 times more expensive**. The common setup keeps the NAT
gateway alongside the endpoints, and it lands at the high end of that range.
Every endpoint option costs more than the one NAT gateway.

Processing is cheaper through an endpoint ($0.01 per GB) than through NAT
($0.045 per GB). That saving only pays for 20 endpoint interfaces once
traffic passes about **100 GB a day** of AWS API traffic. This stack's
traffic is a few megabytes of agent calls and logs, plus image manifests. The
image layers already skip the NAT gateway through the free S3 gateway
endpoint.

### What the decision gives up

- **Traffic to AWS APIs leaves the VPC.** It still goes over TLS to AWS public
  endpoints, but endpoint policies can't restrict it, for example to this
  account's ECR repository.
- **The container instances have open egress** (`0.0.0.0/0`). The task
  security groups are still restricted. Endpoints plus an ECR pull-through
  cache would let the instances' egress be limited to the endpoints'
  security group.

For a short-lived development stack with no real data, these don't justify
doubling or tripling the cost. The production project should decide this
again: there, egress control and endpoint policies may outweigh the cost.
With one NAT gateway per AZ, as production would use, the gap between the
two options is also smaller.
