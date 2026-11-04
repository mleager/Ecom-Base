-- +goose Up
GRANT UPDATE (quantity_reserved) ON inventory TO ecom_app;
GRANT INSERT (id, user_id, status, subtotal_cents, total_cents, shipping_address,
 source_cart_id, source_cart_version, reservation_expires_at) ON orders TO ecom_app;
GRANT INSERT (id, order_id, product_id, sku_snapshot, product_name_snapshot,
 quantity, unit_price_cents, line_total_cents) ON order_items TO ecom_app;
GRANT INSERT (id, order_item_id, product_id, quantity, status, expires_at) ON inventory_reservations TO ecom_app;
GRANT INSERT (id, order_id, attempt_number, status, scenario, simulator_reference) ON payment_attempts TO ecom_app;
GRANT INSERT (id, order_id, previous_status, new_status, reason) ON order_status_history TO ecom_app;
GRANT INSERT (id, user_id, idempotency_key, request_hash, order_id) ON checkout_idempotency TO ecom_app;

-- +goose Down
REVOKE INSERT (id, user_id, idempotency_key, request_hash, order_id) ON checkout_idempotency FROM ecom_app;
REVOKE INSERT (id, order_id, previous_status, new_status, reason) ON order_status_history FROM ecom_app;
REVOKE INSERT (id, order_id, attempt_number, status, scenario, simulator_reference) ON payment_attempts FROM ecom_app;
REVOKE INSERT (id, order_item_id, product_id, quantity, status, expires_at) ON inventory_reservations FROM ecom_app;
REVOKE INSERT (id, order_id, product_id, sku_snapshot, product_name_snapshot,
 quantity, unit_price_cents, line_total_cents) ON order_items FROM ecom_app;
REVOKE INSERT (id, user_id, status, subtotal_cents, total_cents, shipping_address,
 source_cart_id, source_cart_version, reservation_expires_at) ON orders FROM ecom_app;
REVOKE UPDATE (quantity_reserved) ON inventory FROM ecom_app;
