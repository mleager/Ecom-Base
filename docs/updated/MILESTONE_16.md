# Milestone 16: final baseline release

**Goal:** ship Project 1 as a packaged, verified, tagged application image that the scenario projects (2–6) run by digest, without changing its code.

**State:** in progress (tasks 1–4 of 7 done: packaging options decided in [DECISIONS.md](DECISIONS.md#packaging-milestone-16); `cmd/migrate` and minimum-version readiness built and tested; the application image builds and passes its checks; `compose.deploy.yaml` starts it in production mode on empty volumes). It follows Milestone 15 ([observability](MILESTONE_15.md)). Task breakdown: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md#milestone-16--final-baseline-release).

## Release gates

1. **Regression.** All M1–M15 behavior passes. Any remaining limits are written down.
2. **Image.** One application image contains the `api`, `migrate` and `reconcile` binaries and the built SPA. It holds no credentials, fixture bundles or `.env` files, and runs as a non-root user.
3. **Deployment.** Compose runs PostgreSQL with TLS, an explicit migration job, then the API in production mode, with a local mail-capture server so no mail leaves the host. Readiness, a real browser journey and order recovery pass against an owned test database, and a restart keeps the data. No development volume is reset.
4. **Observability.** Configured with `OTEL_*` and `METRICS_ADDR`, the deployed container exports the M15 traces and metrics to a Collector and serves its metrics listener; with them unset, it exports nothing.
5. **Evidence.** Record the observability contract version, tool versions, the `postgres:16-alpine` digest, the application image digest, the source commit, schema and fixture versions, and reproducible run instructions.
6. **Tag.** Tag the healthy baseline.

## Packaging decisions

Decided 2026-11-09 by task 1; reasons in [DECISIONS.md](DECISIONS.md#packaging-milestone-16).

| Topic | Choice |
|---|---|
| Migration job | migrations embedded in a `cmd/migrate` binary in the same application image, run as a one-off job before the API. Readiness accepts a minimum schema version. |
| Runtime base image | distroless `static-debian13:nonroot`, pinned by digest (task 3 moved from `static-debian12`, which no longer receives updates); no in-container health check. |
| Secrets in Compose | an ignored env file per service; never baked into the image. |
| Certificates in Compose | the M14 local CA, mounted read-only; the database service is named `postgres`. Real deployments supply their own. |

## Out of scope

New features, scenario faults and fault-variant images (built per scenario project), the observability stack, dashboards and alerts (Project 4), background workers, real payments and multi-instance scaling ([Milestone 17](MILESTONE_17.md)).
