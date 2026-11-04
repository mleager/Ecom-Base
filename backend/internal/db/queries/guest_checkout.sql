-- name: GuestIntentByID :one
SELECT * FROM guest_checkout_intents WHERE id=$1 AND guest_id=$2;

-- name: LockGuestIntentByKey :one
SELECT * FROM guest_checkout_intents WHERE guest_id=$1 AND idempotency_key=$2 FOR UPDATE;

-- name: GuestIntentOwner :one
SELECT guest_id FROM guest_checkout_intents WHERE id=$1;

-- name: GuestOrderScope :one
SELECT guest_id, guest_intent_id, contact_email FROM orders WHERE id=$1 AND guest_id IS NOT NULL;

-- name: CountGuestIntents :one
SELECT count(*) FROM guest_checkout_intents WHERE guest_id=$1;

-- name: InsertGuestIntent :one
INSERT INTO guest_checkout_intents(id,guest_id,idempotency_key,source_cart_id,cart_version,payment_scenario,payload_hash,contact_digest,contact_email,shipping_address,state,expires_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared',clock_timestamp()+interval '30 days') RETURNING *;

-- name: InsertRetiredGuestIntent :one
INSERT INTO guest_checkout_intents(id,guest_id,idempotency_key,state,expires_at)
VALUES($1,$2,$3,'retired',clock_timestamp()+interval '30 days') RETURNING *;

-- name: ExpireGuestIntents :exec
UPDATE guest_checkout_intents SET state='expired',contact_email=NULL,shipping_address=NULL
WHERE guest_id=$1 AND state='prepared' AND expires_at<=clock_timestamp();

-- name: CloseGuestIntent :execrows
UPDATE guest_checkout_intents SET state=sqlc.arg(state),contact_email=NULL,shipping_address=NULL
WHERE id=sqlc.arg(id) AND guest_id=sqlc.arg(guest_id) AND state=sqlc.arg(previous_state);

-- name: CompleteGuestIntent :execrows
UPDATE guest_checkout_intents SET state='known_order',order_id=$3,contact_email=NULL,shipping_address=NULL
WHERE id=$1 AND guest_id=$2 AND state='prepared';

-- name: FindGuestCheckoutKey :one
SELECT c.request_hash,c.order_id FROM checkout_idempotency c JOIN orders o ON o.id=c.order_id AND o.guest_id=c.guest_id
WHERE c.guest_id=$1 AND c.idempotency_key=$2;

-- name: GuestDatabaseTime :one
SELECT clock_timestamp()::timestamptz;

-- name: CountLiveGuestProofs :one
SELECT count(*) FROM guest_recovery_tokens WHERE consumed_at IS NULL AND expires_at>clock_timestamp()
AND (intent_id=sqlc.narg(intent_id) OR order_id=sqlc.narg(order_id));

-- name: InsertGuestProof :exec
INSERT INTO guest_recovery_tokens(id,guest_id,intent_id,order_id,email_digest,token_hash,expires_at)
VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '15 minutes');

-- name: FindGuestProof :one
SELECT * FROM guest_recovery_tokens WHERE token_hash=$1;

-- name: ConsumeGuestProof :execrows
UPDATE guest_recovery_tokens SET consumed_at=clock_timestamp()
WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp();

-- name: InsertGuestRecoverySession :one
INSERT INTO guest_recovery_sessions(id,guest_id,intent_id,order_id,token_hash,expires_at)
VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '30 minutes') RETURNING *;

-- name: VerifyGuestRecoverySession :one
SELECT * FROM guest_recovery_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp();

-- name: ReadLockGuestRecoverySession :one
SELECT * FROM guest_recovery_sessions WHERE token_hash=$1 FOR SHARE;

-- name: RevokeGuestRecoverySession :exec
UPDATE guest_recovery_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL;
