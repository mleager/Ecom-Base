-- +goose Up
GRANT UPDATE (first_name, last_name) ON users TO ecom_app;
GRANT INSERT (id, user_id, label, recipient_name, line_1, line_2, city, region, postal_code, country_code),
 UPDATE (label, recipient_name, line_1, line_2, city, region, postal_code, updated_at), DELETE ON addresses TO ecom_app;
GRANT INSERT (id, sku, name, description, image_url, unit_price_cents),
 UPDATE (sku, name, description, image_url, unit_price_cents, is_active, updated_at) ON products TO ecom_app;
GRANT INSERT (product_id), UPDATE (quantity_on_hand, updated_at) ON inventory TO ecom_app;
GRANT UPDATE (version, updated_at) ON carts TO ecom_app;
GRANT INSERT (id, cart_id, product_id, quantity), UPDATE (quantity, updated_at), DELETE ON cart_items TO ecom_app;

-- +goose Down
REVOKE UPDATE (first_name, last_name) ON users FROM ecom_app;
REVOKE INSERT (id, user_id, label, recipient_name, line_1, line_2, city, region, postal_code, country_code),
 UPDATE (label, recipient_name, line_1, line_2, city, region, postal_code, updated_at), DELETE ON addresses FROM ecom_app;
REVOKE INSERT (id, sku, name, description, image_url, unit_price_cents),
 UPDATE (sku, name, description, image_url, unit_price_cents, is_active, updated_at) ON products FROM ecom_app;
REVOKE INSERT (product_id), UPDATE (quantity_on_hand, updated_at) ON inventory FROM ecom_app;
REVOKE UPDATE (version, updated_at) ON carts FROM ecom_app;
REVOKE INSERT (id, cart_id, product_id, quantity), UPDATE (quantity, updated_at), DELETE ON cart_items FROM ecom_app;
