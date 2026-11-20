# API contract

[`openapi.yaml`](openapi.yaml) (OpenAPI 3.0.3, API version **1.7.0**) is the contract for the Go API. It has 61 business operations under `/api/v1` and 3 operational routes (`/health/live`, `/health/ready`, `/metrics`). It is the contract the code is checked against, not documentation written after the fact:

- A frontend unit test parses the file and fails if the client's route table and the contract disagree. It also checks the operation inventory in [frontend/API_INTEGRATION.md](../frontend/API_INTEGRATION.md).
- `scripts/release-evidence.sh` records the contract version in every release.

## Design choices

| Choice | Why | Trade-off accepted |
|---|---|---|
| REST and JSON, one versioned base path (`/api/v1`) | Easy to read, test with `curl`, cache and put behind a CDN path rule (`/api/*`) | No partial responses or batching; the SPA makes several small calls per page |
| A single error envelope `{code, message}`, with a stable `code` | Clients branch on `code`, never on message text. Stack traces and SQL errors are never exposed | Less detail for debugging from the client; the detail goes into logs and traces, keyed by request and trace ID |
| Strict input: unknown, duplicate or `null` fields are rejected; 400 for malformed input, 422 for out-of-range values | Typos and stale clients fail loudly instead of being silently ignored | Adding a request field is a breaking change for older clients, so it needs a version bump |
| 404 for both "missing" and "not yours" | IDs of other users' orders and addresses can't be probed | Support can't tell the two apart from the status alone |
| Offset pagination (`limit` 1–100), no total count | No `COUNT(*)` on every list request | No "page 3 of 12" in the UI |
| `Idempotency-Key` required on checkout | A retried or double-clicked checkout maps to one order, permanently (see [backend/CHECKOUT.md](../backend/CHECKOUT.md)) | Clients must create and keep a key per checkout attempt |
| `503 *_outcome_uncertain` when the result of a COMMIT is unknown | The API never guesses that a lost reply means failure; the client retries with the same key | Clients need an "outcome unknown, retrying" state ([frontend/CHECKOUT_RECOVERY.md](../frontend/CHECKOUT_RECOVERY.md)) |
| Short-lived bearer JWT (15 min, kept in memory) plus a rotating refresh cookie (`HttpOnly`, `SameSite=Strict`, path-scoped) | No token in browser storage, where XSS could read it; revocation is checked against the database on every request | One extra refresh call after each page load |
| Cookie-authenticated writes need an exact `Origin` and `X-CSRF-Protection: 1` | Protects against CSRF on top of `SameSite=Strict`, without a token round trip | Non-browser clients must send both headers |
| `__Secure-` cookie names whenever cookies are `Secure` | The browser refuses these cookies over plain HTTP, so they can't be planted or read there | Local HTTP mode and HTTPS mode use different cookie names, so sessions don't carry across modes |
| `429` with `Retry-After` from per-IP limits (IPv6 keyed on its /64). Counters are kept in memory locally, and in PostgreSQL on AWS (`RATE_LIMIT_STORE=postgres`) | Limits hold across several API tasks behind the load balancer | A database write per limited request, and the limits fail closed while the database is down |

## Status codes

| Status | Meaning |
|---|---|
| 400 / 422 | Malformed input / well-formed but invalid input |
| 401 / 403 | Not authenticated / role, Origin or CSRF denied |
| 404 | Missing or not owned (the two are not distinguished) |
| 409 | State conflict: `stale_cart`, `insufficient_inventory`, `idempotency_conflict` and similar |
| 413 / 429 | Body over 64 KiB / rate limited (with `Retry-After`) |
| 500 | Unexpected failure. While the database is unreachable, most routes return 500 `internal_error`; the client message is deliberately generic |
| 503 | Dependency unavailable on classified routes, or a commit outcome is unknown (`*_outcome_uncertain`) |

## Compatibility rules

- The `info.version` follows semver. Adding an operation or an optional response field is a minor bump. Removing or renaming anything, or adding a required request field, is a major bump and needs a new base path.
- Database changes ship as expand-then-contract migrations. `/health/ready` passes when the applied schema is **at least** the minimum the API needs, so a migration can run before the API that uses it.
- The SPA and API ship in one image for each release, so in practice they never run at different versions.
