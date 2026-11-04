-- +goose Up
GRANT UPDATE (status, updated_at) ON orders TO ecom_app;
GRANT UPDATE (status, started_at, completed_at, failure_code) ON payment_attempts TO ecom_app;
GRANT UPDATE (status, updated_at) ON inventory_reservations TO ecom_app;

-- +goose Down
REVOKE UPDATE (status, updated_at) ON inventory_reservations FROM ecom_app;
REVOKE UPDATE (status, started_at, completed_at, failure_code) ON payment_attempts FROM ecom_app;
REVOKE UPDATE (status, updated_at) ON orders FROM ecom_app;
