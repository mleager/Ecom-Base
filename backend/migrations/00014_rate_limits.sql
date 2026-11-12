-- +goose Up
-- Shared request limits for several API tasks (RATE_LIMIT_STORE=postgres).
-- One row per limiter and key per window. Keys are stored only as SHA-256
-- digests, so no address, email or token is kept. UNLOGGED: the counters are
-- short-lived, and losing them in a crash only resets the current windows.
CREATE UNLOGGED TABLE rate_limit_buckets (
 limiter text NOT NULL CHECK(limiter ~ '^[a-z][a-z_]{0,62}$'),
 key_digest bytea NOT NULL CHECK(octet_length(key_digest)=32),
 count integer NOT NULL CHECK(count>=1),
 reset_at timestamptz NOT NULL,
 PRIMARY KEY(limiter,key_digest)
);
CREATE INDEX rate_limit_bucket_expiry ON rate_limit_buckets(reset_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_buckets TO ecom_app;

-- +goose Down
DROP TABLE rate_limit_buckets;
