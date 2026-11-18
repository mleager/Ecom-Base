# Observability contract

**Contract version 1** (Milestone 15). These are the spans, metrics and log fields the API emits. Dashboards, alerts and rollout analysis in the scenario projects should be built against this page, not against the code.

`TestContractListsEveryMetric` (`backend/internal/platform/telemetry/contract_test.go`) creates every instrument the API registers. It fails when a metric is missing from the [metrics table](#metrics), when the table lists one that no longer exists, or when a Prometheus name here differs from what the exporter emits.

Turning telemetry on: [OPERATIONS.md](OPERATIONS.md#telemetry-optional). Design and data rules: [MILESTONE_15.md](../MILESTONE_15.md).

## Change rules

- Adding a span, metric, label or log field is a **minor** change. Add it here in the same commit.
- Renaming or removing one, or changing a label's meaning or values, is a **breaking** change. Raise the contract version and list the change in [DECISIONS.md](../DECISIONS.md).
- Labels and attributes never carry the data listed under [Never recorded](#never-recorded).

## Delivery

| Signal | How it leaves the process | When |
|---|---|---|
| Traces | OTLP/HTTP (protobuf) push to `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, batched | An endpoint is set |
| Metrics | Prometheus text format, pulled from `GET /metrics` on `METRICS_ADDR`. No OTLP metrics push; a Collector scrapes it with its Prometheus receiver. | `METRICS_ADDR` is set |
| Logs | JSON lines on standard output | Always |

`OTEL_SDK_DISABLED=true` turns off traces and the metrics listener.

### Resource

| Attribute | Value |
|---|---|
| `service.name` | `ecom-api`, unless `OTEL_SERVICE_NAME` or `OTEL_RESOURCE_ATTRIBUTES` sets another |
| `service.version` | The module version, when the binary was built from a tagged module. Absent for local builds. |
| `telemetry.sdk.name`, `telemetry.sdk.language`, `telemetry.sdk.version` | Set by the SDK |

Other `OTEL_RESOURCE_ATTRIBUTES` (for example `deployment.environment.name`) are added as given. On the metrics endpoint the resource appears once as `target_info`, not as labels on each series.

## Traces

Context propagation is W3C `traceparent`/`tracestate` only. An incoming trace context is continued only when `TRACE_TRUST_UPSTREAM=true` (M17 task 11): set it only when every request passes a gateway that sets or removes those headers. Otherwise, the default, each request starts a new trace. Any other value fails startup. No baggage. Sampling is the SDK default (parent-based, always on) unless `OTEL_TRACES_SAMPLER` changes it.

| Span | Kind | Parent | Attributes | Error status |
|---|---|---|---|---|
| `{method} {route}`, for example `POST /api/v1/orders` | Server | Incoming `traceparent` with `TRACE_TRUST_UPSTREAM=true`, or none | `http.request.method`, `http.route`, `http.response.status_code`, `url.scheme` (`http`, `https`), `network.protocol.version` (`1.0`, `1.1`, `2`); `error.type` on errors | 5xx (`error.type` is the status code) or a panic (`error.type=panic`). 4xx and 499 are not errors. |
| `{db.operation.name}`, for example `GetProduct` or `BEGIN` | Client | The request span | `db.system.name=postgresql`, `db.operation.name`, `db.query.text`; `error.type` on errors | Any query error |
| `smtp send` | Client | The request span | `server.address`, `server.port`, `email.message.count`; `error.type=delivery_unconfirmed` on failure | Any delivery failure |

- **Not traced:** `/health/live`, `/health/ready`, the admin `/metrics` route, and anything under them. Database queries outside a request span (readiness probes, startup) create no spans but are still counted in the query metrics.
- `http.route` and `{method}` follow the [label values](#label-values) below, so span names are bounded too.
- `db.query.text` is the statement with its `$1` placeholders and without sqlc's `-- name:` comment, at most 4096 bytes. Query arguments are never read.
- Database `error.type` is the five-character SQLSTATE code (for example `23505`), or `canceled`, `timeout` or `other`. The PostgreSQL message is never recorded.
- Mail spans exist only when `MAIL_MODE=smtp`. One span covers one batch of messages sent over one connection.
- A checkout request is one trace: the server span, then its query spans in order, then `smtp send` when it sends mail.

## Metrics

The tested table. **OTel name** is what an OTLP consumer sees; **Prometheus name** is the family on `METRICS_ADDR`. Histograms add `_bucket`, `_sum` and `_count` series. Prometheus label names replace the dots in the attribute names with underscores (`http.route` becomes `http_route`).

| OTel name | Prometheus name | Type | Unit | Labels | Meaning |
|---|---|---|---|---|---|
| `http.server.request.duration` | `http_server_request_duration_seconds` | Histogram | s | `http.request.method`, `http.route`, `http.response.status_class` | Time from the API receiving the request until the handler returns. Buckets: 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10. |
| `http.server.active_requests` | `http_server_active_requests` | Gauge (up-down counter) | {request} | `http.request.method` | Requests in progress. |
| `db.client.operation.duration` | `db_client_operation_duration_seconds` | Histogram | s | `db.system.name`, `db.operation.name`, `error.type` (only on failure) | Query time, including queries outside a request. Buckets: 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10. |
| `db.client.connection.count` | `db_client_connection_count` | Gauge | {connection} | `db.client.connection.pool.name`, `db.client.connection.state` (`used`, `idle`) | Open pool connections by state, read at scrape time. |
| `db.client.connection.max` | `db_client_connection_max` | Gauge | {connection} | `db.client.connection.pool.name` | Maximum pool size (`pool_max_conns`, default 10). |
| `db.client.connection.idle.min` | `db_client_connection_idle_min` | Gauge | {connection} | `db.client.connection.pool.name` | Connections kept open when idle (`pool_min_conns`, default 0). |
| `db.client.connection.pending_requests` | `db_client_connection_pending_requests` | Gauge (up-down counter) | {request} | `db.client.connection.pool.name` | Requests waiting for a pool connection now. |
| `db.client.connection.wait_time` | `db_client_connection_wait_time_seconds` | Histogram | s | `db.client.connection.pool.name`, `error.type` (only on failure) | Time to acquire a pool connection. Same buckets as query duration. |
| `db.client.connection.timeouts` | `db_client_connection_timeouts_total` | Counter | {timeout} | `db.client.connection.pool.name` | Acquires that ended because the request was cancelled or timed out. |
| `ecom.orders.created` | `ecom_orders_created_total` | Counter | {order} | `customer.type` | New orders acknowledged by checkout. Replays are not counted. |
| `ecom.payment.results` | `ecom_payment_results_total` | Counter | {payment} | `payment.result` | Simulated payments settled during checkout. |
| `ecom.checkout.unknown_outcomes` | `ecom_checkout_unknown_outcomes_total` | Counter | {checkout} | `customer.type`, `outcome.reason` | Checkout responses that leave the outcome open: `uncertain` is a 503 `checkout_outcome_uncertain`, `interrupted` is a 202 with processing interrupted. |
| `ecom.guest.sessions.created` | `ecom_guest_sessions_created_total` | Counter | {session} | none | Guest sessions created. |
| `ecom.rate_limit.rejections` | `ecom_rate_limit_rejections_total` | Counter | {request} | `limiter.name`, `limiter.reason` | Requests rejected by an in-process key limiter. |
| `ecom.email.deliveries` | `ecom_email_deliveries_total` | Counter | {delivery} | `email.result` | SMTP delivery attempts (one per batch). Not recorded when mail is disabled. |

Every series of the business counters with fixed labels starts at 0, so `rate()` and ratio alerts work before the first event. HTTP and query series appear on first use.

### Label values

| Label | Values |
|---|---|
| `http.request.method` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `CONNECT`, `TRACE`; anything else is `_OTHER` |
| `http.route` | The chi route pattern, for example `/api/v1/orders/{id}`; `static` for every response from the built SPA (pages, assets, missing assets); `unmatched` for unknown paths and wrong methods (404 and 405) |
| `http.response.status_class` | `1xx` to `5xx`; `other` outside 100–599. A client that went away before the response is recorded as 499, so `4xx`. |
| `db.system.name` | `postgresql` |
| `db.operation.name` | The sqlc query name from `backend/queries/*.sql` (for example `GetProduct`), or for hand-written SQL one of `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `WITH`, `VALUES`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `SET`, `LOCK`, `CALL`, `DO`, `OTHER` |
| `db.client.connection.pool.name` | `main` |
| `db.client.connection.state` | `used`, `idle` |
| `error.type` (database metrics) | A SQLSTATE code, `canceled`, `timeout` or `other` |
| `customer.type` | `account`, `guest` |
| `payment.result` | `accepted`, `rejected` |
| `outcome.reason` | `uncertain`, `interrupted` |
| `limiter.name` | `auth_ip`, `auth_ip_site`, `auth_email`, `auth_email_client`, `security_ip`, `security_user`, `security_token`, `password_reset_address`, `guest_bootstrap`, `guest_bootstrap_site`, `guest_read`, `guest_write`, `guest_owner`, `guest_rotation`, `guest_recovery_request`, `guest_recovery_confirmation`, `guest_checkout_prepare`, `guest_checkout_mail`, `guest_checkout_proof` |
| `limiter.reason` | `throttled` (the key is over its limit), `capacity` (the limiter's key table is full) |
| `email.result` | `sent`, `failed` |

Not counted as rate-limit rejections: the password-hashing concurrency limit, the database-backed security-mail limit and the guest write-slot limit ([DECISIONS.md](../DECISIONS.md#observability-milestone-15)).

### Runtime and process metrics

The same endpoint serves the Prometheus Go collector (`go_*`, for example `go_goroutines`, `go_gc_duration_seconds`, `go_memstats_heap_alloc_bytes`) and process collector (`process_*`, for example `process_cpu_seconds_total`, `process_resident_memory_bytes`, `process_open_fds`). Their names come from `prometheus/client_golang` v1.25.0, not from this project, and are not listed one by one.

### Suggested queries

| Signal | PromQL |
|---|---|
| Request rate by route | `sum by (http_route) (rate(http_server_request_duration_seconds_count[5m]))` |
| 5xx ratio | `sum(rate(http_server_request_duration_seconds_count{http_response_status_class="5xx"}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m]))` |
| p95 latency by route | `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[5m])))` |
| Pool saturation | `db_client_connection_count{db_client_connection_state="used"} / db_client_connection_max` |
| Rate-limit spike | `sum by (limiter_name) (rate(ecom_rate_limit_rejections_total[5m]))` |
| Mail failure ratio | `rate(ecom_email_deliveries_total{email_result="failed"}[15m]) / rate(ecom_email_deliveries_total[15m])` |

Readiness is not a metric. Probe `GET /health/ready` on the API listener (200 or 503).

### The admin `/metrics` route

The API listener's own `GET /metrics` (admin bearer token required) predates M15 and is unchanged. It serves one counter, `ecom_authenticated_requests_total`, in its own format. It is not part of this contract; scrape `METRICS_ADDR` instead.

## Logs

One JSON object per line on standard output, from Go's `slog` JSON handler. Every line has `time` (RFC 3339 with nanoseconds), `level` (`INFO`, `WARN`, `ERROR`) and `msg`.

| `msg` | Level | Fields |
|---|---|---|
| `http request` | INFO | `request_id` (32 hex characters, also sent as `X-Request-ID`), `method`, `status`, `duration_ms`; `client_closed=true` and `handler_status` when the client went away (then `status` is 499) |
| `request panic` | ERROR | `request_id`, `panic_type` (the Go type of the panic value, for example `string` or `*runtime.TypeAssertionError`), `stack` (the goroutine stack). The value itself is never logged: it can hold request data (M17 task 11). |
| `checkout processing interrupted` | WARN | `request_id`, `order_id`, `payment_status` |
| `order integrity failure` | ERROR | `request_id` |
| `security email delivery unconfirmed` | WARN | `request_id` |
| `refresh token reuse revoked a session` | WARN | `request_id` (M17 task 9: a rotated refresh token came back after the 30-second grace) |
| `API starting` | INFO | `address`, `tls`, `static` |
| `API stopped` | ERROR | `error`; a listener failure includes its cause, for example `HTTP listener failed: listen tcp …: bind: address already in use` (M17 task 11) |
| `telemetry configured` | INFO | `traces`, `metrics_address` |
| `telemetry export failed` | WARN | `error`, `suppressed` (failures not logged since the last line; at most one line a minute) |
| `metrics listener stopped` | WARN | none |
| `telemetry shutdown incomplete` | WARN | none |

- **Trace link:** when a line is logged inside a traced request, it also carries `trace_id` (32 hex characters) and `span_id` (16 hex characters) of the request's server span. With traces off, no line carries them, and log content is the same as before M15.
- Health probes are logged like any other request but never carry `trace_id`.
- Messages from Go's HTTP server (for example failed TLS handshakes) are logged at `WARN` with the server's own text in `msg`.

## Never recorded

No span, metric label or log field contains passwords, tokens, cookies, `Authorization` headers, email addresses, street addresses, query strings, raw URLs or paths, SQL arguments, PostgreSQL error messages, or mail subjects and bodies. Metric labels never contain user, product, order, session or request IDs. Internal record IDs appear only in the `checkout processing interrupted` log line (`order_id`).
