-- +goose Up
ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN guest_id uuid REFERENCES guest_principals(id) ON DELETE RESTRICT;
ALTER TABLE orders ADD COLUMN guest_intent_id uuid UNIQUE;
ALTER TABLE orders ADD COLUMN contact_email text;
ALTER TABLE orders ADD CONSTRAINT orders_one_owner CHECK(num_nonnulls(user_id,guest_id)=1);
ALTER TABLE orders ADD CONSTRAINT orders_guest_snapshot CHECK (
 (guest_id IS NULL AND guest_intent_id IS NULL AND contact_email IS NULL) OR
 (guest_id IS NOT NULL AND guest_intent_id IS NOT NULL AND contact_email IS NOT NULL
 AND contact_email=lower(btrim(contact_email)) AND octet_length(contact_email) BETWEEN 3 AND 254)
);
ALTER TABLE orders ADD CONSTRAINT orders_id_user UNIQUE(id,user_id);
ALTER TABLE orders ADD CONSTRAINT orders_id_guest UNIQUE(id,guest_id);
ALTER TABLE orders ADD CONSTRAINT orders_guest_handoff UNIQUE(id,guest_intent_id,guest_id,source_cart_id);
ALTER TABLE orders ADD CONSTRAINT orders_user_cart FOREIGN KEY(source_cart_id,user_id) REFERENCES carts(id,user_id);
ALTER TABLE orders ADD CONSTRAINT orders_guest_cart FOREIGN KEY(source_cart_id,guest_id) REFERENCES carts(id,guest_id);
ALTER TABLE guest_checkout_intents ADD CONSTRAINT guest_intent_cart_version UNIQUE(id,guest_id,source_cart_id,cart_version);
ALTER TABLE orders ADD CONSTRAINT orders_guest_intent FOREIGN KEY(guest_intent_id,guest_id,source_cart_id,source_cart_version)
 REFERENCES guest_checkout_intents(id,guest_id,source_cart_id,cart_version);
ALTER TABLE guest_checkout_intents DROP CONSTRAINT guest_checkout_intents_order_id_fkey;
ALTER TABLE guest_checkout_intents ADD CONSTRAINT guest_intent_order FOREIGN KEY(order_id,id,guest_id,source_cart_id)
 REFERENCES orders(id,guest_intent_id,guest_id,source_cart_id);
CREATE INDEX orders_guest_recent ON orders(guest_id,created_at DESC,id DESC) WHERE guest_id IS NOT NULL;

ALTER TABLE checkout_idempotency ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE checkout_idempotency ADD COLUMN guest_id uuid REFERENCES guest_principals(id) ON DELETE RESTRICT;
ALTER TABLE checkout_idempotency ADD CONSTRAINT checkout_one_owner CHECK(num_nonnulls(user_id,guest_id)=1);
ALTER TABLE checkout_idempotency ADD CONSTRAINT checkout_user_order FOREIGN KEY(order_id,user_id) REFERENCES orders(id,user_id);
ALTER TABLE checkout_idempotency ADD CONSTRAINT checkout_guest_order FOREIGN KEY(order_id,guest_id) REFERENCES orders(id,guest_id);
CREATE UNIQUE INDEX checkout_guest_key ON checkout_idempotency(guest_id,idempotency_key) WHERE guest_id IS NOT NULL;

CREATE TABLE guest_recovery_tokens (
 id uuid PRIMARY KEY, guest_id uuid NOT NULL REFERENCES guest_principals(id) ON DELETE RESTRICT,
 intent_id uuid, order_id uuid, email_digest bytea NOT NULL CHECK(octet_length(email_digest)=32),
 token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, CHECK(expires_at>created_at), CHECK(num_nonnulls(intent_id,order_id)=1),
 FOREIGN KEY(intent_id,guest_id) REFERENCES guest_checkout_intents(id,guest_id),
 FOREIGN KEY(order_id,guest_id) REFERENCES orders(id,guest_id)
);
CREATE INDEX guest_proof_intent ON guest_recovery_tokens(intent_id,expires_at) WHERE consumed_at IS NULL;
CREATE INDEX guest_proof_order ON guest_recovery_tokens(order_id,expires_at) WHERE consumed_at IS NULL;
CREATE INDEX guest_proof_expiry ON guest_recovery_tokens(expires_at);

CREATE TABLE guest_recovery_sessions (
 id uuid PRIMARY KEY, guest_id uuid NOT NULL REFERENCES guest_principals(id) ON DELETE RESTRICT,
 intent_id uuid, order_id uuid, token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, CHECK(expires_at>created_at), CHECK(num_nonnulls(intent_id,order_id)=1),
 FOREIGN KEY(intent_id,guest_id) REFERENCES guest_checkout_intents(id,guest_id),
 FOREIGN KEY(order_id,guest_id) REFERENCES orders(id,guest_id)
);
CREATE INDEX guest_recovery_expiry ON guest_recovery_sessions(expires_at);

GRANT INSERT(guest_id,guest_intent_id,contact_email) ON orders TO ecom_app;
GRANT INSERT(guest_id) ON checkout_idempotency TO ecom_app;
GRANT INSERT(id,guest_id,idempotency_key,source_cart_id,cart_version,payment_scenario,payload_hash,contact_digest,contact_email,shipping_address,state,expires_at),
 UPDATE(state,order_id,contact_email,shipping_address) ON guest_checkout_intents TO ecom_app;
GRANT SELECT ON guest_recovery_tokens,guest_recovery_sessions TO ecom_app;
GRANT INSERT(id,guest_id,intent_id,order_id,email_digest,token_hash,expires_at), UPDATE(consumed_at) ON guest_recovery_tokens TO ecom_app;
GRANT INSERT(id,guest_id,intent_id,order_id,token_hash,expires_at), UPDATE(revoked_at) ON guest_recovery_sessions TO ecom_app;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM orders WHERE guest_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM guest_checkout_intents)
 OR EXISTS(SELECT 1 FROM guest_recovery_tokens) OR EXISTS(SELECT 1 FROM guest_recovery_sessions) THEN
  RAISE EXCEPTION 'guest checkout data exists; use a compatible binary or an approved restore';
 END IF;
END $$;
-- +goose StatementEnd
DROP TABLE guest_recovery_sessions;
DROP TABLE guest_recovery_tokens;
REVOKE INSERT(id,guest_id,idempotency_key,source_cart_id,cart_version,payment_scenario,payload_hash,contact_digest,contact_email,shipping_address,state,expires_at),
 UPDATE(state,order_id,contact_email,shipping_address) ON guest_checkout_intents FROM ecom_app;
ALTER TABLE checkout_idempotency DROP CONSTRAINT checkout_user_order, DROP CONSTRAINT checkout_guest_order, DROP CONSTRAINT checkout_one_owner;
ALTER TABLE checkout_idempotency DROP COLUMN guest_id, ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE guest_checkout_intents DROP CONSTRAINT guest_intent_order;
ALTER TABLE guest_checkout_intents ADD FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE orders DROP CONSTRAINT orders_guest_intent, DROP CONSTRAINT orders_guest_cart, DROP CONSTRAINT orders_user_cart,
 DROP CONSTRAINT orders_guest_handoff, DROP CONSTRAINT orders_id_guest, DROP CONSTRAINT orders_id_user,
 DROP CONSTRAINT orders_guest_snapshot, DROP CONSTRAINT orders_one_owner;
ALTER TABLE orders DROP COLUMN guest_id, DROP COLUMN guest_intent_id, DROP COLUMN contact_email, ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE guest_checkout_intents DROP CONSTRAINT guest_intent_cart_version;
