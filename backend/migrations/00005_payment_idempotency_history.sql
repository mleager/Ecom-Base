-- +goose Up
CREATE TABLE checkout_idempotency (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
 request_hash text NOT NULL, -- SHA-256 of immutable request intent; see CHECKOUT_DESIGN.md

 order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'completed' CHECK (status='completed'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (user_id,idempotency_key)
);

CREATE TABLE payment_attempts (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 attempt_number integer NOT NULL CHECK (attempt_number>0),
 status text NOT NULL CHECK (status IN ('pending','processing','succeeded','failed','cancelled')),
 scenario text NOT NULL CHECK (scenario IN ('accept','reject')),
 simulator_reference text NOT NULL UNIQUE,
 failure_code text, started_at timestamptz, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (order_id,attempt_number)
);

CREATE TABLE order_status_history (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 previous_status text, new_status text NOT NULL,
 reason text, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (new_status IN ('pending_payment','confirmed','payment_failed','cancelled')),
 CHECK (previous_status IS NULL OR previous_status IN ('pending_payment','confirmed','payment_failed','cancelled'))
);

CREATE UNIQUE INDEX one_active_payment_attempt_per_order
 ON payment_attempts(order_id) WHERE status IN ('pending','processing');

CREATE INDEX history_order_time ON order_status_history(order_id,created_at);

-- +goose Down
DROP TABLE order_status_history;
DROP TABLE payment_attempts;
DROP TABLE checkout_idempotency;
