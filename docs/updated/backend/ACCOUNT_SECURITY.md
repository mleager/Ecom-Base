# Account security

Authentication, sessions and the email-based security flows. Code is in `backend/internal/auth` and `backend/internal/platform/email`.

## Passwords

- Argon2id: 64 MiB, 3 iterations, parallelism 1, 16-byte random salt, 32-byte key, stored in PHC format.
- 15–128 Unicode code points, at most 512 UTF-8 bytes. Never trimmed, normalized or truncated; no character-class rules.
- At most 2 hashes run at once per process. Extra work gets 429 `auth_capacity`.
- Login failures are generic. A dummy hash runs for unknown accounts. Weaker stored hashes are upgraded after a successful login.

## Access tokens (JWT)

- HS256 only, with a dedicated secret (≥ 32 bytes, base64 in `JWT_SECRET_BASE64`). Unsigned tokens and algorithm swaps are rejected.
- 15-minute lifetime. Claims: `iss=ecom`, `aud=ecom-api`, `sub` (user UUID), `sid` (session UUID), `jti`, `iat`, `nbf`, `exp`. 30-second skew allowance.
- Sent only as `Authorization: Bearer`. The browser keeps it in memory.
- **Every request** checks that the session is unrevoked and unexpired and loads the current user and role. The role claim in the token is not trusted.

## Refresh sessions

- Opaque 32-byte token (base64url). Only its SHA-256 digest is stored in `user_sessions`.
- Fixed 7-day expiry from creation, with no sliding extension. Rotated on every refresh under a row lock, so exactly one concurrent refresh wins.
- Cookie `ecom_refresh`: host-only, `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, `Secure` when `APP_ENV=production` or TLS is on.
- A lost rotation reply can leave the old cookie unusable. The user signs in again.
- Logout revokes the session from the cookie alone (no JWT needed) and always returns 204.

## Browser request protection

- Cookie operations (login, refresh, logout) and every security POST require an exact `Origin` match with `FRONTEND_ORIGIN` and the header `X-CSRF-Protection: 1`.
- CORS allows credentials only for that exact origin, never `*`.

## Rate limits

All limits are in-process and keyed on `RemoteAddr`; forwarding headers are ignored. Each limiter map holds at most 10,000 keys and fails closed when full.

| Scope | Limit |
|---|---|
| Login and register | 20/min per peer IP, 5/min per canonical email |
| Security POSTs | 20/min per peer IP |
| Token redemption | 5/min per token digest |
| Authenticated security actions | 5/min per user |
| Verification email | 5/hour per account, 60 s cooldown (persisted) |
| Email-change request | 5/hour per account, 60 s cooldown (persisted) |
| Password reset | 3/hour, at most 3 live links (persisted) |
| Public reset handlers | 32 concurrent |

## Security flows

| Flow | Proof required | Effect |
|---|---|---|
| Change password | Session + current password; new password must differ | Update the hash, increment `credential_version`, invalidate all security tokens and any pending email change, **revoke all sessions**. The user signs in again. |
| Verify email | Session + current password at both request and confirm, plus the emailed token | Sets `email_verified_at`. Sessions are kept. |
| Change email | Verified current email; session + current password at request and at each confirmation; separate tokens to **both** old and new mailboxes | The old email stays active until the second proof commits. Then the email changes, stays verified, all sessions are revoked, and the user signs in with the new email. |
| Reset password | Emailed token for an active account with a verified email | Replace the password, increment the version, invalidate all tokens, cancel any pending email change, revoke all sessions. No automatic login. |

All accounts start **unverified**. Nothing was backfilled. Password reset and email change need a verified email. An account that never verified has no self-service recovery.

## Tokens

32 random bytes, base64url (43 characters). Only the SHA-256 digest is stored. Each token is bound to a purpose, account, email and credential version.

| Purpose | Lifetime | Rule |
|---|---|---|
| `verify_email` | 30 min | One live token; resending invalidates the previous one |
| `email_change_old`, `email_change_new` | 30 min from the request | Replacing the request invalidates both |
| `reset_password` | 15 min | Up to 3 live tokens; a new request does not invalidate older ones |

Every invalid case (wrong purpose, expired, used, cancelled, wrong account) returns the same 400 `invalid_security_token`. Opening a link never changes anything; the user must submit a form.

## Endpoints

All under `/api/v1`. Full schemas are in OpenAPI.

| Method and path | Result |
|---|---|
| `POST /users/me/password` | 200 `SecurityChangeResult`; clears the refresh cookie |
| `GET /users/me/security` | Whether delivery is available, plus the owner's pending email change |
| `POST /users/me/email-verification` (+ `/confirm`) | 202 `MailRequestResult` / 200 User |
| `POST /users/me/email-change` (+ `/confirm`, `/cancel`) | 202; confirm returns 202 pending after the first proof and 200 after the second; cancel returns 204 |
| `POST /auth/password-resets` | Always the same 202 receipt, sent 5 s after admission |
| `POST /auth/password-resets/confirm` | 200 `SecurityChangeResult`; no cookie changes |

`MailRequestResult.delivery`: `accepted` (the SMTP server accepted it, which is not the same as inbox delivery), `unconfirmed`, or `not_required`. `SecurityChangeResult.notification`: `accepted`, `unconfirmed` or `not_applicable`.

Key error codes: 403 `reauthentication_failed` (wrong current password); 409 `credentials_changed`, `credential_version_exhausted`, `email_conflict`, `email_verification_required`; 503 `security_unavailable` (before commit) or `security_outcome_unknown` (commit unknown). Never retry after `security_outcome_unknown`. Sign in and check the state instead.

## Email delivery

- The standard library `net/smtp` over a context-bound connection. `SMTP_TLS_MODE` must be `starttls` or `tls`. TLS 1.2+, system trust roots, hostname verification, AUTH PLAIN only after TLS.
- Sent once, after the database commit, with no locks held. The whole SMTP exchange has 2 s, with 2 concurrent batches and 16 KiB per message. No retry queue.
- Mail failure never rolls back a committed change.
- Links are built from `FRONTEND_ORIGIN` and fixed paths: `/verify-email#token=…`, `/confirm-email-change#token=…`, `/reset-password#token=…`. Plain-text messages only, with no tracking or remote images.

## Concurrency

Every flow locks in the order user → pending email request → tokens → sessions. Argon2 runs **before** the transaction. Under the lock, the code rechecks the password hash, credential version and the caller's session. If any of them changed, it returns 409 `credentials_changed`. The final email update runs inside a savepoint, so a duplicate-email violation can still commit the request cancellation and return a definite `email_conflict`.

Configuration and pruning steps are in [OPERATIONS.md](OPERATIONS.md).
