# Security

Authentication, sessions, browser protections, rate limits and email-based account recovery. Code is in `backend/internal/auth` and `backend/internal/platform/email`.

## Design choices

| Choice | Why | Trade-off accepted |
|---|---|---|
| **Argon2id** (64 MiB, 3 iterations), at most 2 hashes at once per process | Memory-hard against GPU cracking, with a bound on memory per task | Extra sign-ins wait or get 429 under bursts |
| **Passphrases:** 15–128 characters, never trimmed or normalised, no character-class rules | Follows current NIST guidance; nothing surprising happens to what the user typed | Users can't pick short passwords |
| **15-minute JWT kept in memory**, plus an **opaque refresh cookie** (7 days, rotated on every use, stored as a digest) | No token in browser storage for XSS to steal; a stolen access token expires quickly | A refresh call after each page load |
| **Session checked in the database on every request** | Logout, password change, deactivation and role changes take effect immediately | One indexed read per request |
| **Refresh-token reuse revokes the session**, after a 30-second grace period | A copied refresh token is detected the moment either holder uses an old one; the grace period covers two tabs refreshing at once | A lost rotation reply can sign the user out |
| **Exact `Origin` plus `X-CSRF-Protection: 1`** on every cookie-authenticated write, on top of `SameSite=Strict` | Defence in depth against CSRF, with no CSRF token to manage | Non-browser clients must send both headers |
| **`__Secure-` cookie names whenever cookies are `Secure`** | A plain-HTTP page can't plant or overwrite them | HTTP and HTTPS runs on the same host keep separate sessions |
| **Email links carry the token in the URL fragment** | The fragment never reaches server logs or `Referer` headers; the SPA removes it before routing | The link only works in a browser that runs the SPA |
| **Mail is sent once, after the database commit**, over STARTTLS or TLS only | A mail failure never undoes a committed change; no plaintext fallback | No retry queue. The user sees `delivery: unconfirmed` and can resend |

## Security flows

| Flow | Proof required | Effect |
|---|---|---|
| Change password | Session + current password | New hash, all tokens invalidated, **all sessions revoked** |
| Verify email | Session + current password + emailed token | Email marked verified |
| Change email | Verified email, current password, and tokens sent to **both** the old and new addresses | The old address stays active until both proofs are in, then all sessions are revoked |
| Reset password | Emailed token, for an active account with a verified email | New password, all sessions revoked, no automatic sign-in |

Tokens are 32 random bytes, stored as digests, and bound to purpose, account, email and credential version. Every invalid case returns the same `400 invalid_security_token`. Opening a link never changes anything; the user must submit a form. Under the row lock, each flow rechecks the password hash, credential version and session, so concurrent changes return `409 credentials_changed` instead of both succeeding.

Password reset never reveals whether an account exists: it always returns the same 202, after the same delay. Registration, by contrast, **does** return `409 email_conflict`. This is an accepted trade-off: clear sign-up feedback, with enumeration slowed by the per-email and per-IP limits below.

## Rate limits

| Choice | Why |
|---|---|
| The client IP is the TCP peer, or `CloudFront-Viewer-Address` only when `TRUSTED_PROXY=cloudfront` | One header set by CloudFront, with no hop counting; other forwarding headers are ignored, so spoofing them has no effect |
| IPv6 is keyed on its /64, with a looser /48 tier for sign-in and guest creation | A /64 is the smallest network a host is given, so per-address limits could be bypassed by rotating addresses |
| Failed sign-ins count per email **and** client (5/min), and per email (20/min); successful sign-ins never count | A stranger's failures lock out only the stranger's network, while guessing spread over many networks is still capped |
| Counters are shared in PostgreSQL on AWS and **fail closed** | Several API tasks enforce one budget; if the database can't answer, the request is refused rather than admitted unlimited |

| Scope | Limit |
|---|---|
| Sign-in and register | 20/min per client, 80/min per IPv6 /48 |
| Failed sign-ins | 5/min per email and client, 20/min per email |
| Security POSTs | 20/min per client; 5/min per user for authenticated actions |
| Token redemption | 5/min per token |
| Verification and email-change mail | 5/hour per account, 60 s cooldown |
| Password reset | 3/hour, at most 3 live links |
| Guest creation | 5/hour per client, 20/hour per IPv6 /48 |
| Guest reads / writes | 120/min / 30/min per client |

Shared IPv4 addresses (carrier-grade NAT) are a known source of false positives.

## Known limits

- Accounts start unverified, and password reset needs a verified email, so an account that never verified has no self-service recovery.
- HS256 with one shared secret; rotating it invalidates every access token, while refresh sessions survive.
- No MFA, CAPTCHA or WAF. The production design would add AWS WAF in front of CloudFront.
