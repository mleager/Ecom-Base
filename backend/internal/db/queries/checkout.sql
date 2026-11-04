-- name: CheckoutActor :one
SELECT id FROM users WHERE id = $1 AND is_active = true;

-- name: FindCheckoutIntent :one
SELECT c.request_hash, c.order_id, o.source_cart_id
FROM checkout_idempotency AS c JOIN orders AS o ON o.id = c.order_id
WHERE c.user_id = $1 AND c.idempotency_key = $2 AND o.user_id = c.user_id;

-- name: LockCheckoutKey :exec
SELECT pg_advisory_xact_lock(sqlc.arg(namespace)::integer, sqlc.arg(key)::integer);

-- name: CheckoutAddress :one
SELECT * FROM addresses WHERE id = $1 AND user_id = $2;

-- name: CheckoutLines :many
SELECT c.product_id, c.quantity, p.sku, p.name, p.unit_price_cents, p.is_active
FROM cart_items AS c JOIN products AS p ON p.id = c.product_id
WHERE c.cart_id = $1 ORDER BY c.product_id;

-- name: ReserveCheckoutStock :execrows
UPDATE inventory SET quantity_reserved = quantity_reserved + sqlc.arg(quantity)::integer, updated_at = now()
WHERE product_id = sqlc.arg(product_id)
 AND quantity_on_hand - quantity_reserved >= sqlc.arg(quantity)::integer;

-- name: CreatePendingOrder :one
INSERT INTO orders (id, user_id, status, subtotal_cents, total_cents, shipping_address,
 source_cart_id, source_cart_version, reservation_expires_at, guest_id, guest_intent_id, contact_email)
VALUES ($1, $2, 'pending_payment', $3, $3, $4, $5, $6, now() + interval '15 minutes', $7, $8, $9)
RETURNING *;

-- name: CreateCheckoutItem :one
INSERT INTO order_items (id, order_id, product_id, sku_snapshot, product_name_snapshot,
 quantity, unit_price_cents, line_total_cents)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;

-- name: CreateCheckoutReservation :exec
INSERT INTO inventory_reservations (id, order_item_id, product_id, quantity, status, expires_at)
VALUES ($1, $2, $3, $4, 'active', $5);

-- name: CreateInitialPayment :exec
INSERT INTO payment_attempts (id, order_id, attempt_number, status, scenario, simulator_reference)
VALUES ($1, $2, 1, 'pending', $3, $4);

-- name: CreateInitialHistory :exec
INSERT INTO order_status_history (id, order_id, previous_status, new_status, reason)
VALUES ($1, $2, NULL, 'pending_payment', 'checkout_created');

-- name: RecordCheckoutIntent :exec
INSERT INTO checkout_idempotency (id, user_id, idempotency_key, request_hash, order_id, guest_id)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: CheckoutOrder :one
SELECT sqlc.embed(o), sqlc.embed(p) FROM orders AS o
JOIN payment_attempts AS p ON p.order_id = o.id AND p.attempt_number = 1
WHERE o.id = $1 AND (o.user_id = $2 OR o.guest_id = $3);

-- name: CheckoutOrderItems :many
SELECT * FROM order_items WHERE order_id = $1 ORDER BY product_id;
