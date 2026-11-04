-- name: LockOwnedOrder :one
SELECT * FROM orders WHERE id = $1 AND (user_id = $2 OR guest_id = $3) FOR UPDATE;

-- name: ReadLockOwnedOrder :one
SELECT * FROM orders WHERE id = $1 AND (user_id = $2 OR guest_id = $3) FOR SHARE;

-- name: LockOrderPayments :many
SELECT * FROM payment_attempts WHERE order_id = $1 ORDER BY attempt_number FOR UPDATE;

-- name: LockOrderReservations :many
SELECT r.* FROM inventory_reservations AS r JOIN order_items AS i ON i.id = r.order_item_id
WHERE i.order_id = $1 ORDER BY r.product_id FOR UPDATE OF r;

-- name: ActiveReservedQuantity :one
SELECT coalesce(sum(quantity), 0)::bigint FROM inventory_reservations WHERE product_id = $1 AND status = 'active';

-- name: ClaimPayment :execrows
UPDATE payment_attempts SET status = 'processing', started_at = clock_timestamp()
WHERE id = $1 AND status = 'pending';

-- name: ConsumeReservedStock :execrows
UPDATE inventory SET quantity_on_hand = quantity_on_hand - sqlc.arg(quantity)::integer,
 quantity_reserved = quantity_reserved - sqlc.arg(quantity)::integer, updated_at = clock_timestamp()
WHERE product_id = sqlc.arg(product_id) AND quantity_reserved >= sqlc.arg(quantity)::integer
 AND quantity_on_hand >= sqlc.arg(quantity)::integer;

-- name: ReleaseReservedStock :execrows
UPDATE inventory SET quantity_reserved = quantity_reserved - sqlc.arg(quantity)::integer, updated_at = clock_timestamp()
WHERE product_id = sqlc.arg(product_id) AND quantity_reserved >= sqlc.arg(quantity)::integer;

-- name: TransitionReservation :execrows
UPDATE inventory_reservations SET status = $2, updated_at = clock_timestamp() WHERE id = $1 AND status = 'active';

-- name: FinishPayment :execrows
UPDATE payment_attempts SET status = sqlc.arg(new_status), failure_code = sqlc.narg(failure_code), completed_at = clock_timestamp()
WHERE id = sqlc.arg(id) AND status = sqlc.arg(expected_status);

-- name: FinishOrder :execrows
UPDATE orders SET status = $2, updated_at = clock_timestamp() WHERE id = $1 AND status = 'pending_payment';

-- name: AppendOrderHistory :exec
INSERT INTO order_status_history (id, order_id, previous_status, new_status, reason)
VALUES ($1, $2, 'pending_payment', $3, $4);

-- name: ListOwnedOrderIDs :many
SELECT id FROM orders WHERE user_id = sqlc.narg(user_id) OR guest_id = sqlc.narg(guest_id) ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit)::bigint OFFSET sqlc.arg(page_offset)::bigint;

-- name: ReadOrderPayments :many
SELECT * FROM payment_attempts WHERE order_id = $1 ORDER BY attempt_number;

-- name: OwnedOrderExists :one
SELECT EXISTS(SELECT 1 FROM orders WHERE id = $1 AND (user_id = $2 OR guest_id = $3));
