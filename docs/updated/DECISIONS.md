# Key decisions

The choices that shape the whole project, with the reason for each. Topic documents hold the details. The full per-task decision logs are in the original `docs/*/IMPLEMENTATION_DECISIONS.md` files.

## Infrastructure and tooling

| Decision | Reason |
|---|---|
| One Go API, one PostgreSQL database. No queue, Redis, worker, scheduler, reverse proxy or payment provider. | The exercise is about application invariants and SQL transactions. Extra infrastructure would hide them. |
| Local Go, goose and sqlc binaries; Docker runs PostgreSQL only. | Fast native feedback; no tooling images to maintain. |
| `GOTOOLCHAIN=local`; `go.mod` stays at `go 1.25.1`. | Prevents silent toolchain downloads. Newer installed Go (1.27.3) builds it unchanged. |
| Exact npm pins (`save-exact`, `engine-strict`), `npm ci` only. | Reproducible frontend installs. |
| `postgres:16-alpine` is a moving tag; record its digest in release evidence. | It is not an immutable pin. |
| No lint/format framework beyond `gofmt`, `go vet` and `.editorconfig`. | Avoids dependencies without a demonstrated need. |

## Data and transactions

| Decision | Reason |
|---|---|
| Money is `BIGINT` cents, USD only, capped at 1,000,000,000,000 per value. | No floating point; stays below JavaScript's exact-integer limit. |
| T1 (reserve) and T2 (settle) are separate transactions, with a committed processing claim in between and simulation outside any transaction. | No locks held during payment work; every crash point is recoverable. |
| Idempotency fingerprint is a canonical SHA-256 of the original intent, and lookup happens before reading the mutable cart. | A retry stays valid after checkout empties the cart. |
| A lost COMMIT reply is resolved by a fresh-connection lookup under the same key lock; if still unknown, return 503. | Absence of evidence is not proof of rollback. |
| Recovery is an explicit operator CLI (dry-run by default). | No hidden background worker; every action is auditable. |
| Retire products and deactivate users instead of deleting them. | Order history stays intact. |
| Runtime and migrator database roles are separate, with column-scoped grants. | Limits the damage of an application bug. |

## Security

| Decision | Reason |
|---|---|
| Argon2id (64 MiB, 3 iterations, parallelism 1), at most 2 concurrent hashes per process. | Memory-hard hashing with bounded resource use. |
| Passwords are 15–128 code points, at most 512 bytes, never trimmed or normalized. | Supports passphrases; no surprising transformations. |
| 15-minute HS256 JWT in memory plus a 7-day fixed refresh cookie, rotated on use. | Short exposure window; no token in browser storage. |
| Database session check on every request. | Logout, deactivation and role changes take effect immediately. |
| Exact Origin plus `X-CSRF-Protection: 1` on every cookie-based write. | CSRF defence in addition to SameSite=Strict. |
| Rate limits are in-process and keyed on `RemoteAddr`; forwarding headers are ignored. | Correct for a single direct deployment. A proxy would need a deliberate change. |
| Email links carry tokens in the URL fragment; the app removes the fragment before routing and keeps the token in memory. | Tokens never reach server logs, Referer headers or browser storage. |
| SMTP via the Go standard library, STARTTLS or TLS only, sent once after commit. | No new dependency and no plaintext fallback. Mail failure never undoes a committed change. |

## Frontend

| Decision | Reason |
|---|---|
| Native `fetch`, React context and hooks; no state, HTTP or form library. | The requirements do not need one. |
| One typed API boundary with runtime response guards and OpenAPI contract tests; no code generator. | One place for error, retry and credential rules. |
| Writes are **send-once**. Only reads (and name-only profile PATCH) may replay once after a definitive 401. | A replayed mutation could duplicate a committed change. |
| Web Locks and BroadcastChannel are required. If unavailable, the app fails closed. | Safe cross-tab coordination without storing tokens. |
| Checkout recovery stores the original key and body in localStorage before sending. | Lets the shopper resume the exact original request after a crash or reload. |
| Tailwind (`tw:` prefix, no Preflight) coexists with CSS Modules; shadcn components are copied into the repo. | Incremental migration without breaking existing styles. |

## Scope

| Decision | Reason |
|---|---|
| Keep both `accept` and `reject` payment scenarios, chosen explicitly by the shopper. | Shows both settlement and stock release. |
| Rejection does not refill the cart. | T1 consumed the cart; rebuilding it is a deliberate shopper action. |
| Guest checkout keeps shipping and contact on the server; the browser keeps only a reference. | No personal data in localStorage. |
| Sign-in never merges carts. The shopper picks **Keep account cart** or **Use guest cart**. | No silent data changes. |
| Search is literal, case-insensitive substring matching on name or SKU. No ranking, facets or search service. | Enough for the portfolio catalog. |
| No count endpoints; pagination is Previous/Next only. | Avoids extra queries and invented totals. |
