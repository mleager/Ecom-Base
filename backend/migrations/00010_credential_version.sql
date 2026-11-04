-- +goose Up
ALTER TABLE users ADD COLUMN credential_version bigint NOT NULL DEFAULT 0 CHECK (credential_version >= 0);
GRANT UPDATE (credential_version) ON users TO ecom_app;

-- +goose Down
REVOKE UPDATE (credential_version) ON users FROM ecom_app;
ALTER TABLE users DROP COLUMN credential_version;
