-- name: CreateGuestPrincipal :exec
INSERT INTO guest_principals(id) VALUES($1);

-- name: CreateGuestCart :exec
INSERT INTO carts(id,guest_id) VALUES($1,$2);

-- name: CreateGuestSession :one
-- Idle for 7 days, or 30 days at most (migration 15).
INSERT INTO guest_sessions(id,guest_id,token_hash,expires_at,absolute_expires_at)
VALUES($1,$2,$3,clock_timestamp()+interval '7 days',clock_timestamp()+interval '30 days') RETURNING *;

-- name: RotateGuestSession :one
INSERT INTO guest_sessions(id,guest_id,token_hash,expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *;

-- name: ExtendGuestSession :one
-- Use moves the idle deadline to 7 days ahead, never past the absolute
-- deadline and never backwards, and writes at most once an hour. A row
-- without absolute_expires_at (written by the previous release) never moves.
UPDATE guest_sessions SET expires_at=least(coalesce(absolute_expires_at,expires_at),clock_timestamp()+interval '7 days')
WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()
AND expires_at<least(coalesce(absolute_expires_at,expires_at),clock_timestamp()+interval '7 days')-interval '1 hour'
RETURNING *;

-- name: FindGuestSession :one
SELECT * FROM guest_sessions WHERE token_hash=$1;

-- name: VerifyGuestSession :one
SELECT * FROM guest_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp();

-- name: LockGuestPrincipal :one
SELECT id FROM guest_principals WHERE id=$1 FOR UPDATE;

-- name: ReadLockGuestPrincipal :one
SELECT id FROM guest_principals WHERE id=$1 FOR SHARE;

-- name: RevokeGuestSession :exec
UPDATE guest_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL;

-- name: LockGuestCart :one
SELECT * FROM carts WHERE guest_id=$1 FOR UPDATE;

-- name: ReadLockGuestCart :one
SELECT * FROM carts WHERE guest_id=$1 FOR SHARE;

-- name: LockChoiceCarts :many
SELECT * FROM carts WHERE user_id=sqlc.arg(user_id) OR guest_id=sqlc.arg(guest_id) ORDER BY id FOR UPDATE;

-- name: LockChoiceAccountSession :one
SELECT id FROM user_sessions WHERE id=sqlc.arg(session_id) AND user_id=sqlc.arg(user_id)
AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;

-- name: FindGuestCartChoice :one
SELECT * FROM guest_cart_choices WHERE session_id=$1 AND guest_id=$2;

-- name: SaveGuestCartChoice :exec
INSERT INTO guest_cart_choices(session_id,user_id,guest_id,choice,guest_version,account_version,resulting_guest_version,resulting_account_version)
VALUES($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT(session_id,guest_id) DO UPDATE SET choice=EXCLUDED.choice,guest_version=EXCLUDED.guest_version,
account_version=EXCLUDED.account_version,resulting_guest_version=EXCLUDED.resulting_guest_version,
resulting_account_version=EXCLUDED.resulting_account_version,updated_at=clock_timestamp();

-- name: GuestHasPreparedIntent :one
SELECT EXISTS(SELECT 1 FROM guest_checkout_intents WHERE guest_id=$1 AND state='prepared');
