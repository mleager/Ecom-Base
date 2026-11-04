# Milestone 1 — Registration, Sessions, and Authorization

**Date:** 2026-10-18 (America/New_York).
**Scope:** Customer registration, login, refresh/logout sessions, authenticated
account reads, and administrator authorization. Milestone 1 remains incomplete.

## Implemented behavior

- Customer registration creates the user and its persistent cart in one pgx
  transaction. Email is canonicalized and role/activation input is not accepted.
- Passwords use Argon2id (64 MiB, three iterations, parallelism one, random
  16-byte salt, 32-byte key). Parsing is allocation-bounded, comparison is constant
  time, verification uses a dummy for unknown accounts, and legacy supported
  verifiers are upgraded after a successful login. Hashing concurrency is two.
- Access JWTs use pinned HS256, required issuer/audience/type/identity/time claims,
  a 15-minute lifetime, and 30-second skew allowance. Current database session,
  user activation, subject binding, and role determine authorization.
- Refresh tokens contain 32 random bytes, stored only as a SHA-256 verifier of
  their canonical base64url cookie value. Rotation locks the current row and
  rechecks expiry in the guarded update. A concurrent stale request returns 401
  without clearing a replacement cookie. Expiry is never extended.
- PostgreSQL supplies both session creation and its exact seven-day deadline.
  Cookies use that absolute deadline; no positive Max-Age is calculated across
  application/database clocks. Logout revokes only the cookie's session and
  clears the cookie without requiring an access token.
- Login/refresh/logout enforce exact Origin and custom-header CSRF checks. CORS
  uses the configured origin, credentials, and bounded explicit method/header
  allowlists. JSON input rejects unknown, null, duplicate, missing, and malformed
  fields. Cookies are host-only, HttpOnly, SameSite=Strict, and Secure outside
  explicit local mode. Token/account responses are no-store.
- Runtime permissions in migration 6 are column-scoped. Runtime SQL cannot change
  user roles/activation, create schema objects, or modify goose metadata. No new
  domain tables or services were introduced.

Implemented operations are POST `/api/v1/auth/register`, `/auth/login`,
`/auth/refresh`, `/auth/logout` under the same API prefix, GET `/api/v1/users/me`,
and administrator-only GET `/metrics`. The metric is an observed per-process
counter of requests that passed authentication; it is not a throughput claim.

## Verified environment and commands

Native Go 1.25.1 windows/amd64, goose 3.27.1, and sqlc 1.31.1 were used.
Dependencies include chi 5.3.1, pgx 5.10.0, golang-jwt/jwt 5.3.1, and
golang.org/x/crypto 0.54.0, with exact checksums in `go.sum`. PostgreSQL reported
16.13 and goose version 6. Docker was used only for the existing database;
no tooling/API images were built or pulled.

| Command/check | Observed result |
|---|---|
| `./scripts/dev.ps1 migrate` | Migration 6 applied to the development database |
| `./scripts/dev.ps1 generate` | Native sqlc generation passed |
| `./scripts/dev.ps1 check` | Formatting, sqlc vet/generation consistency, goose validation, go vet, and unit tests passed |
| `go build -o bin/ecom-api.exe ./backend/cmd/api` | Passed |
| OpenAPI 3.0.3 validator | `docs/api/openapi.yaml: OK` |
| `./scripts/dev.ps1 integration -Race` | Unit, real HTTP, PostgreSQL integration, and race checks passed |
| Repeated concurrency command below | Both targeted cases passed three runs with race detection |

The repeated command ran in the same local environment populated by the
integration script, with the test administrative connection set explicitly:

```text
go test -race -tags=integration -run 'TestAuthentication/(duplicate_signup_race|refresh_concurrency_and_scoped_logout)$' -count=3 ./backend/internal/platform/integration
```

The final full race run reported:

```text
ok  ecom/backend/internal/auth                  2.177s
ok  ecom/backend/internal/platform/config       1.161s
ok  ecom/backend/internal/platform/httpserver   1.224s
ok  ecom/backend/internal/platform/integration  5.134s
real PostgreSQL server 16.13; schema version 6
```

The repeated concurrency run passed in 4.431 seconds. These durations are
observations, not service-level targets. Tests created and dropped only their own
randomly named disposable databases, using the installed native goose executable.
No development users or administrator accounts were seeded by the tests.

## Important experiments

- Concurrent duplicate registration produced one 201, one 409, one customer, and
  one cart. A test-only cart-insert trigger failure rolled registration back
  completely and returned no SQL details to the client.
- Concurrent refresh produced one 200 and one 401, retained one session and its
  exact original expiry, and rotated the verifier. A test-only update failure
  returned no replacement cookie and left the old verifier usable after rollback.
- Logout immediately invalidated both old and refreshed access JWTs for that
  session; a separately created session remained usable.
- An expired database session and an inactive user could not authorize requests
  or refresh. Inactive login was rejected. A JWT signed with the test key but
  combining another existing user with the original session was rejected.
- Current role promotion/demotion changed access to metrics without issuing a
  replacement JWT. An added JWT role claim did not grant administrator access.
  Role input was rejected and runtime SQL role changes were denied.
- Wrong-password and unknown-account login responses matched. Password whitespace
  was preserved. A supported older Argon2id verifier upgraded after valid login.
- Unit tests rejected invalid JWT algorithms, unsigned/bad signatures, key URLs,
  wrong type/issuer/audience, malformed identities, missing required claims,
  invalid lifetimes, future validity, and expiry. Other unit tests exercised
  malformed PHC strings, memory/work bounds, credential/JSON limits, cookie
  attributes, duplicate cookies, CSRF/CORS, rate-map bounds, and concurrent limits.

One initial test intermittently found a session-duration mismatch when the
application and PostgreSQL supplied its two timestamps separately. Creation and
expiry now use the same PostgreSQL timestamp, and the final test requires an
exact seven-day interval. The assertion was not relaxed.

## Password hashing observation

Executed locally:

```text
go test ./backend/internal/auth -run '^$' -bench BenchmarkPasswordHash -benchtime=1x -count=1
BenchmarkPasswordHash-32   1   82475600 ns/op   67120120 B/op   61 allocs/op
```

This single sample on the observed Intel Core i9-14900K is approximately 82.5 ms
and 64 MiB per operation. It is not a production load test, percentile estimate,
or guarantee. The agreed hashing policy was retained.

## Limits and remaining work

Profile updates, saved addresses, catalog/admin HTTP operations, cart operations,
checkout, payment settlement, and recovery are not implemented by this increment.
The full Project 1 exit criteria are not yet satisfied. Browser/frontend flows
and Linux/macOS execution were not verified in this run.

The existing schema retains only the current refresh verifier. It does not
support token-family replay detection or recovery of a replacement secret after
a committed rotation's response is lost; the client must sign in again. Rate
limits are bounded and local to one process, as specified. No administrator was
automatically provisioned, and no interactive API process was left running.
