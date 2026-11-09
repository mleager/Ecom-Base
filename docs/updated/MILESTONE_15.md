# Milestone 15: observability

**Goal:** build OpenTelemetry instrumentation into the API, so the tagged baseline ([Milestone 16](MILESTONE_16.md)) can be observed in every scenario without code changes. The instrumentation covers:
- traces
- request rate, error and latency metrics
- database pool and runtime metrics
- business counters
- logs linked to traces

The milestone also makes the database pool size configurable, because a scenario must be able to tune it without a code change.

The observability **stack** is not part of this milestone. The Collector pipeline, Prometheus, Tempo, Loki, Grafana, dashboards, alerts, SLOs and load tests belong to Project 4 ([PORTFOLIO_MASTER_CONTEXT.md](PORTFOLIO_MASTER_CONTEXT.md#56-key-engineering-requirements)). Here, tests and a minimal Collector check prove the telemetry leaves the process correctly.

**State:** in progress (tasks 1–6 of 7 done: design confirmed in [DECISIONS.md](DECISIONS.md#observability-milestone-15), `govulncheck` in `check`; telemetry bootstrap in `platform/telemetry`, off unless configured; HTTP spans, request metrics and trace-linked logs; query spans, pool metrics and `pool_max_conns`; business counters and SMTP spans; the published [contract](backend/OBSERVABILITY_CONTRACT.md), Collector export check and overhead measurement). It follows Milestone 14 ([production serving and HTTPS](MILESTONE_14.md)). Task breakdown: [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md#milestone-15--observability).

## Why before the release

- **Scenarios can't change code.** The scenario projects (2–6) are solved with operations only ([scenario rule](PORTFOLIO_MASTER_CONTEXT.md#24-scenario-rule-no-application-code-changes)). Instrumentation or settings missing from the tagged image can never be added during an incident.
- **Project 2 needs it first.** Its rollout analysis aborts a canary on the application's error and latency metrics, before Project 4 exists.
- **Project 7 builds on it.** The event-driven version (`v2.0.0`) continues traces through the outbox, which needs trace context in the base.
- **There is little to observe today.** The API exposes one counter (`ecom_authenticated_requests_total`, admin-only at `/metrics`) and JSON request logs with `request_id`.

## Selected design

Confirmed by task 1 (2026-11-08). Versions, measured cost and the reasons for writing the HTTP and pgx instrumentation here are in [DECISIONS.md](DECISIONS.md#observability-milestone-15).

| Decision | Choice | Reason |
|---|---|---|
| SDK | OpenTelemetry Go SDK for traces and metrics, configured with the standard `OTEL_*` environment variables | Vendor-neutral. Each scenario project points the same image at its own Collector. |
| Default | Off. Without `OTEL_EXPORTER_OTLP_ENDPOINT`, traces are not exported, and without `METRICS_ADDR` there is no metrics listener. | Development, the test suites and the default run modes stay unchanged, with no outbound connections. |
| Metrics endpoint | A Prometheus exporter on a separate internal listener, `METRICS_ADDR`, unauthenticated and never routed publicly. The existing admin-only `/metrics` route stays unchanged. | Prometheus can't hold short-lived admin bearer tokens. A separate listener also stays out of reach behind a CDN or load balancer. Keeping `/metrics` avoids an OpenAPI change. |
| HTTP | Server spans and request metrics named by the chi **route pattern** (`/api/v1/orders/{id}`). SPA and static paths share one `static` label. `/health/*` and `/metrics` are not traced. | Bounded metric labels, and it keeps the existing rule against logging raw URLs or query strings. |
| Database | One span per pgx query through pgx's tracer hook, with the statement text and **never the arguments**. `pgxpool` statistics as gauges. | Slow queries and pool exhaustion become visible without leaking data. |
| Pool size | Honor pgx's standard `pool_max_conns` parameter in `DATABASE_URL`; keep 10 when it is absent. Today the code always overrides it with 10. | Project 4's connection-exhaustion experiment tunes the pool through configuration. No new variable is needed. |
| Business metrics | Counters for orders created and payment results (accepted, rejected), unknown checkout outcomes, guest sessions created, rate-limit rejections by limiter, and email send failures | These are the signals the scenario projects alert on. |
| Logs | The existing slog JSON logs gain `trace_id` and `span_id` when a span is active, next to `request_id` | A log store can link a log line to its trace. |
| Export safety | Batch export with a bounded queue that drops when full. Flushing fits inside the 10 s graceful shutdown. | A missing or slow Collector must never slow down or fail requests. |
| Contract | `backend/OBSERVABILITY_CONTRACT.md` lists every span name, metric name and label, and log field the release emits | Scenario projects build dashboards and alerts against a documented, versioned contract, not against the code. |
| Export check | A pinned OpenTelemetry Collector image with only the `debug` exporter, started by hand for the check. No storage, dashboards or alerts. | Proves real OTLP export end to end without building Project 4's stack here. |

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

## Signals for the scenario projects

M15 builds no dashboards or alerts. The contract must still make these possible, because Projects 2 and 4 build them from it:

| Area | Signals the contract must provide |
|---|---|
| Service | Rate, errors and latency (p50/p95/p99) by route, readiness, in-flight requests |
| Database | Pool in use, idle and waiting, acquire duration, query latency by statement |
| Commerce | Orders and payment results, unknown checkout outcomes, guest sessions, rate-limit rejections, email failures |

Expected alerts include a high 5xx ratio, high p95 latency, pool saturation, failing readiness and a spike in rate-limit rejections.

## Release gates for M15

1. **Off by default.** With no `OTEL_*` or `METRICS_ADDR` settings, behavior, log content, every test suite and network activity are unchanged.
2. **Traces.**
   - Tests with an in-memory exporter show that a guest checkout and an account checkout each produce one trace, from the HTTP server span through its database spans, plus an SMTP span where mail is sent.
   - None of the data the data rules forbid appears in them.
3. **Metrics.**
   - `METRICS_ADDR` serves the RED, pool, runtime and business metrics in Prometheus format.
   - Each business counter has a test that increments it.
   - Unknown API paths and SPA routes create no new label values.
4. **Logs.** Request logs carry `trace_id` and `span_id` when tracing is on, and are unchanged when it is off.
5. **Pool size.** `pool_max_conns` in `DATABASE_URL` sets the pool size, and the default stays 10.
6. **Export check.**
   - With the API in `serve-https` mode pointed at the debug Collector, a browser journey's spans and metrics arrive over OTLP.
   - An unreachable endpoint never delays requests.
   - The latency difference with telemetry on is measured and recorded.
7. **Contract.** `backend/OBSERVABILITY_CONTRACT.md` matches what the release emits.
8. **Regression.** The backend check and `integration --race`, frontend unit, type and build checks, the full browser suite and the HTTPS browser group all pass.

## Risks

| Risk | Mitigation |
|---|---|
| New dependencies (the OTel modules) against the "no dependency without a need" rule | Record the need in DECISIONS.md, pin versions, and run `govulncheck` in `check` |
| Label cardinality explosion | Route patterns only, a fixed `static` label, and a test that unknown paths add no series |
| Personal data in telemetry | The data rules, plus tests that check exported spans and logs for forbidden fields |
| A Collector outage affects requests | Bounded queues that drop when full, export off the request path, and a test with an unreachable endpoint |
| The contract drifts from the code | A test lists the registered metric names and fails when one is missing from the contract |

## Out of scope

- The observability stack: Collector pipelines, Prometheus, Tempo, Loki, Grafana, dashboards, alert rules, SLOs and load tests (Project 4).
- Browser (frontend) instrumentation and continuous profiling.
- Shipping telemetry to AWS ([Milestone 17](MILESTONE_17.md)).
