-- name: GuestCreationLock :exec
SELECT pg_advisory_xact_lock(137013,4);

-- name: CountLiveGuestSessions :one
SELECT count(*) FROM guest_sessions WHERE revoked_at IS NULL AND expires_at>clock_timestamp();

-- name: CreateGuestPrincipal :exec
INSERT INTO guest_principals(id) VALUES($1);

-- name: CreateGuestCart :exec
INSERT INTO carts(id,guest_id) VALUES($1,$2);

-- name: CreateGuestSession :one
INSERT INTO guest_sessions(id,guest_id,token_hash,expires_at)
VALUES($1,$2,$3,clock_timestamp()+interval '30 days') RETURNING *;

-- name: RotateGuestSession :one
INSERT INTO guest_sessions(id,guest_id,token_hash,expires_at) VALUES($1,$2,$3,$4) RETURNING *;

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
