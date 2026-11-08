# Milestone 16: final baseline release

**Goal:** ship Project 1 as a packaged, verified, tagged application image that the scenario projects (2–6) run by digest, without changing its code.

**State:** not started. It follows Milestone 15 ([observability](MILESTONE_15.md)). Task breakdown: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md#milestone-16--final-baseline-release).

## Release gates

1. **Regression.** All M1–M15 behavior passes. Any remaining limits are written down.
2. **Image.** One application image contains the API binary and the built SPA. It holds no credentials, fixture bundles or `.env` files, and runs as a non-root user.
3. **Deployment.** Compose runs PostgreSQL with TLS, an explicit migration job, then the API. Readiness, real browser journeys and order recovery pass against an owned test database. No development volume is reset.
4. **Observability.** Configured with `OTEL_*` and `METRICS_ADDR`, the deployed container exports the M15 traces and metrics to a Collector and serves its metrics listener; with them unset, it exports nothing.
5. **Evidence.** Record the observability contract version, tool versions, the `postgres:16-alpine` digest, the application image digest, the source commit, schema and fixture versions, and reproducible run instructions.
6. **Tag.** Tag the healthy baseline.

## Known decisions to make

| Topic | Options |
|---|---|
| Migration job | goose built into a separate migrator image, or a `migrate` subcommand in the API binary. Embedding goose as a library changes the "installed CLI" decision. |
| Runtime base image | distroless static, or Alpine. Distroless is smaller; Alpine has a shell for debugging. |
| Secrets in Compose | `env_file` pointing at an ignored file, or Compose `secrets`. Never baked into the image. |
| Certificates in Compose | Reuse the M14 local CA for verification. Real deployments supply their own. |

## Out of scope

New features, scenario faults and fault-variant images (built per scenario project), the observability stack, dashboards and alerts (Project 4), background workers, real payments and multi-instance scaling ([Milestone 17](MILESTONE_17.md)).
