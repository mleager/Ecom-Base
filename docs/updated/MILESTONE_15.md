# Milestone 15: observability

**Goal:** instrument the API with OpenTelemetry, so the tagged baseline ([Milestone 16](MILESTONE_16.md)) can be observed in every scenario without code changes. That means:
- traces
- request rate, error and latency metrics
- database pool and runtime metrics
- business counters
- logs linked to traces

A local observability stack proves it end to end.

**State:** planned, not started. It follows Milestone 14 ([production serving and HTTPS](MILESTONE_14.md)). Task breakdown: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md#milestone-15--observability).

## Why before the release

- **Scenarios can't change code.** The portfolio scenarios are solved with operations only. Instrumentation missing from the tagged image can never be added during an incident.
- **Later versions build on it.** The payment and outbox version (`v2.0.0`) continues traces through the outbox. That needs trace context to exist in the base.
- **There is little to observe today.** The API exposes one counter (`ecom_authenticated_requests_total`, admin-only at `/metrics`) and JSON request logs with `request_id`.

## Selected design

These are proposed; task 1 confirms them and records them in [DECISIONS.md](DECISIONS.md).

| Decision | Choice | Reason |
|---|---|---|
| SDK | OpenTelemetry Go SDK for traces and metrics, configured with the standard `OTEL_*` environment variables | Vendor-neutral. The same build exports to a local Collector and to AWS (ADOT) in [Milestone 17](MILESTONE_17.md). |
| Default | Off. Without `OTEL_EXPORTER_OTLP_ENDPOINT`, traces are not exported. | Development, the test suites and the default run modes stay unchanged, with no outbound connections. |
| Metrics endpoint | A Prometheus exporter on a separate internal listener, `METRICS_ADDR`, unauthenticated and never routed publicly. The existing admin-only `/metrics` route stays unchanged. | Prometheus can't hold short-lived admin bearer tokens. A separate listener also stays out of reach behind a CDN or ALB. Keeping `/metrics` avoids an OpenAPI change. |
| HTTP | Server spans and request metrics named by the chi **route pattern** (`/api/v1/orders/{id}`). SPA and static paths share one `static` label. `/health/*` and `/metrics` are not traced. | Bounded metric labels, and it keeps the existing rule against logging raw URLs or query strings. |
| Database | One span per pgx query through pgx's tracer hook, with the statement text and **never the arguments**. `pgxpool` statistics as gauges. | Slow queries and pool exhaustion become visible without leaking data. |
| Business metrics | Counters for orders created and payment results (accepted, rejected), unknown checkout outcomes, guest sessions created, rate-limit rejections by limiter, and email send failures | These are the signals the incident scenarios alert on. |
| Logs | The existing slog JSON logs gain `trace_id` and `span_id` when a span is active, next to `request_id` | One click from a log line to its trace. |
| Export safety | Batch export with a bounded queue that drops when full. Flushing fits inside the 10 s graceful shutdown. | A missing or slow Collector must never slow down or fail requests. |
| Local stack | `compose.observability.yaml`: OpenTelemetry Collector, Prometheus, Tempo, Loki with a log shipper, and Grafana. Dashboards and alert rules are files in the repository. All images are pinned. | Reproducible, and the scenarios hub can reuse it unchanged. |

## Data rules

- **Never record** in a span, metric label or log: passwords, tokens, cookies, `Authorization` headers, email addresses, street addresses, query strings, raw URLs, or SQL arguments.
- **Metric labels are bounded:**
  - route pattern
  - method
  - status class
  - limiter name
  - outcome

  They never contain user, product, order or session IDs.
- **Internal record IDs** (order, product) may appear as span attributes only. They are never metric labels.

## Dashboards and alerts

| Dashboard | Shows |
|---|---|
| Service overview | Rate, errors and latency (p50/p95/p99) by route, readiness, and in-flight requests |
| Database | Pool in use, idle and waiting, acquire duration, and query latency by statement |
| Commerce | Orders and payment results, unknown checkout outcomes, guest sessions, rate-limit rejections, email failures |

Starting alert rules: high 5xx ratio, p95 latency above a threshold, pool saturation, readiness failing, and a spike in rate-limit rejections. Each scenario's runbook starts from one of these alerts.

## Release gates for M15

1. **Off by default.** With no `OTEL_*` settings, behavior, log content, every test suite and network activity are unchanged.
2. **Traces.**
   - A guest checkout and an account checkout each produce one trace, from the HTTP server span through its database spans, plus an SMTP span where mail is sent.
   - The traces are visible in Tempo.
   - None of the data the data rules forbid appears in them.
3. **Metrics.**
   - Prometheus scrapes RED, pool, runtime and business metrics from `METRICS_ADDR`.
   - Unknown API paths and SPA routes create no new label values.
4. **Logs.** Request logs carry `trace_id` and `span_id` when tracing is on, and Grafana links logs to traces in both directions.
5. **Dashboards and alerts.**
   - They load from files.
   - Stopping PostgreSQL fires the readiness and 5xx alerts.
   - A load test fires the latency alert.
6. **Overhead.** The latency difference with telemetry on is measured and recorded.
7. **Regression.** The backend check and `integration --race`, frontend unit, type and build checks, the full browser suite and the HTTPS browser group all pass.

## Risks

| Risk | Mitigation |
|---|---|
| New dependencies (the OTel modules) against the "no dependency without a need" rule | Record the need in DECISIONS.md, pin versions, and run `govulncheck` in `check` |
| Label cardinality explosion | Route patterns only, a fixed `static` label, and a test that unknown paths add no series |
| Personal data in telemetry | The data rules, plus tests that check exported spans and logs for forbidden fields |
| A Collector outage affects requests | Bounded queues that drop when full, export off the request path, and a test with an unreachable endpoint |

## Out of scope

Browser (frontend) instrumentation, continuous profiling, SLO tooling beyond alert rules, and shipping telemetry to AWS (that is part of [Milestone 17](MILESTONE_17.md)).
