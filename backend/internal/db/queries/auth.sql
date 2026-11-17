-- name: CreateCustomer :one
INSERT INTO users (id, first_name, last_name, email, password_hash)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: CreateCustomerCart :exec
INSERT INTO carts (id, user_id) VALUES ($1, $2);

-- name: FindUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: LockUser :one
SELECT * FROM users WHERE id = $1 FOR UPDATE;

-- name: RehashPassword :exec
UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1;

-- name: CreateSession :one
INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at)
VALUES ($1, $2, $3, now() + interval '7 days')
RETURNING *;

-- name: LockRefreshSession :one
SELECT * FROM user_sessions
WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
FOR UPDATE;

-- name: FindRefreshSession :one
SELECT * FROM user_sessions WHERE refresh_token_hash = $1;

-- name: FindUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: LockUserSessions :many
SELECT id FROM user_sessions WHERE user_id = $1 ORDER BY id FOR UPDATE;

-- name: SessionIsActive :one
SELECT EXISTS(SELECT 1 FROM user_sessions
 WHERE id = sqlc.arg(session_id) AND user_id = sqlc.arg(user_id)
 AND revoked_at IS NULL AND expires_at > clock_timestamp());

-- name: ReplacePassword :execrows
UPDATE users SET password_hash = $2, credential_version = credential_version + 1, updated_at = clock_timestamp()
WHERE id = $1 AND credential_version < 9223372036854775807;

-- name: RevokeUserSessions :exec
UPDATE user_sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL;

-- name: RotateRefreshSession :execrows
-- The replaced verifier is kept to recognise its reuse (migration 16).
UPDATE user_sessions SET previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = $2,
 last_used_at = now(), rotated_at = clock_timestamp()
WHERE id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp();

-- name: FindRotatedRefreshSession :one
SELECT * FROM user_sessions WHERE previous_refresh_token_hash = $1;

-- name: LockRotatedRefreshSession :one
-- Rechecked under the row lock: a live session whose previous verifier is
-- still this one, and whether it was rotated within the 30-second grace.
SELECT id, coalesce(rotated_at > clock_timestamp() - interval '30 seconds', false)::boolean AS within_grace
FROM user_sessions
WHERE id = $1 AND previous_refresh_token_hash = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp()
FOR UPDATE;

-- name: RevokeSessionByID :exec
UPDATE user_sessions SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL;

-- name: RevokeSession :exec
UPDATE user_sessions SET revoked_at = now()
WHERE refresh_token_hash = $1 AND revoked_at IS NULL;

-- name: GetSessionPrincipal :one
SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.created_at, u.email_verified_at
FROM user_sessions AS s
JOIN users AS u ON u.id = s.user_id
WHERE s.id = sqlc.arg(session_id) AND u.id = sqlc.arg(user_id)
  AND u.is_active AND s.revoked_at IS NULL AND s.expires_at > now();

