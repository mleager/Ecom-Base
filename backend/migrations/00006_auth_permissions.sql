-- +goose Up
GRANT INSERT (id, first_name, last_name, email, password_hash) ON users TO ecom_app;
GRANT UPDATE (password_hash, updated_at) ON users TO ecom_app;
GRANT INSERT (id, user_id) ON carts TO ecom_app;
GRANT INSERT (id, user_id, refresh_token_hash, expires_at) ON user_sessions TO ecom_app;
GRANT UPDATE (refresh_token_hash, revoked_at, last_used_at) ON user_sessions TO ecom_app;

-- +goose Down
REVOKE UPDATE (refresh_token_hash, revoked_at, last_used_at) ON user_sessions FROM ecom_app;
REVOKE INSERT (id, user_id, refresh_token_hash, expires_at) ON user_sessions FROM ecom_app;
REVOKE INSERT (id, user_id) ON carts FROM ecom_app;
REVOKE UPDATE (password_hash, updated_at) ON users FROM ecom_app;
REVOKE INSERT (id, first_name, last_name, email, password_hash) ON users FROM ecom_app;

