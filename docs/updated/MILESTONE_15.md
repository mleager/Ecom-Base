# Milestone 15: final baseline release

**Goal:** ship Project 1 as a packaged, verified, tagged application that Projects 2–6 can fork without changing its healthy behavior.

**State:** not started. It follows Milestone 14 ([production serving and HTTPS](MILESTONE_14.md)). Task breakdown: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md#milestone-15--final-baseline-release).

## Release gates

1. **Regression.** All M1–M14 behavior passes. Any remaining limits are written down.
2. **Image.** One application image contains the API binary and the built SPA. It holds no credentials, fixture bundles or `.env` files, and runs as a non-root user.
3. **Deployment.** Compose runs PostgreSQL with TLS, an explicit migration job, then the API. Readiness, real browser journeys and order recovery pass against an owned test database. No development volume is reset.
4. **Evidence.** Record tool versions, the `postgres:16-alpine` digest, the application image digest, the source commit, schema and fixture versions, and reproducible run instructions.
5. **Tag.** Tag the healthy baseline.

## Known decisions to make

| Topic | Options |
|---|---|
| Migration job | goose built into a separate migrator image, or a `migrate` subcommand in the API binary. Embedding goose as a library changes the "installed CLI" decision. |
| Runtime base image | distroless static, or Alpine. Distroless is smaller; Alpine has a shell for debugging. |
| Secrets in Compose | `env_file` pointing at an ignored file, or Compose `secrets`. Never baked into the image. |
| Certificates in Compose | Reuse the M14 local CA for verification. Real deployments supply their own. |

## Out of scope

New features, scenario faults (those belong to Projects 2–6), background workers, real payments and multi-instance scaling.
