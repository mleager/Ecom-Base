-- +goose Up
CREATE TABLE guest_principals (
 id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE guest_sessions (
 id uuid PRIMARY KEY, guest_id uuid NOT NULL REFERENCES guest_principals(id) ON DELETE RESTRICT,
 token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, CHECK(expires_at>created_at)
);
CREATE INDEX guest_session_expiry ON guest_sessions(expires_at);
CREATE INDEX guest_session_owner ON guest_sessions(guest_id);
ALTER TABLE carts ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE carts ADD COLUMN guest_id uuid UNIQUE REFERENCES guest_principals(id) ON DELETE RESTRICT;
ALTER TABLE carts ADD CONSTRAINT carts_one_owner CHECK(num_nonnulls(user_id,guest_id)=1);
ALTER TABLE carts ADD CONSTRAINT carts_id_user UNIQUE(id,user_id);
ALTER TABLE carts ADD CONSTRAINT carts_id_guest UNIQUE(id,guest_id);
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_id_user UNIQUE(id,user_id);

CREATE TABLE guest_cart_choices (
 session_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 guest_id uuid NOT NULL REFERENCES guest_principals(id) ON DELETE RESTRICT,
 choice text NOT NULL CHECK(choice IN ('keep_account','use_guest')),
 guest_version bigint NOT NULL CHECK(guest_version BETWEEN 1 AND 9007199254740991),
 account_version bigint NOT NULL CHECK(account_version BETWEEN 1 AND 9007199254740991),
 resulting_guest_version bigint NOT NULL CHECK(resulting_guest_version BETWEEN 1 AND 9007199254740991),
 resulting_account_version bigint NOT NULL CHECK(resulting_account_version BETWEEN 1 AND 9007199254740991),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(session_id,guest_id),
 FOREIGN KEY(session_id,user_id) REFERENCES user_sessions(id,user_id) ON DELETE CASCADE,
 CHECK((choice='keep_account' AND resulting_guest_version=guest_version AND resulting_account_version=account_version)
 OR (choice='use_guest' AND resulting_guest_version=guest_version+1 AND resulting_account_version=account_version+1))
);

-- Storage/transfer guard only: no intent INSERT/UPDATE grant or endpoint until Task 5.
CREATE TABLE guest_checkout_intents (
 id uuid PRIMARY KEY, guest_id uuid NOT NULL REFERENCES guest_principals(id) ON DELETE RESTRICT,
 idempotency_key uuid NOT NULL, source_cart_id uuid, cart_version bigint,
 payment_scenario text CHECK(payment_scenario IN ('accept','reject')),
 payload_hash bytea CHECK(octet_length(payload_hash)=32),
 contact_digest bytea CHECK(octet_length(contact_digest)=32), contact_email text, shipping_address jsonb,
 state text NOT NULL CHECK(state IN ('prepared','rejected','retired','expired','known_order')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 order_id uuid UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
 UNIQUE(id,guest_id), UNIQUE(guest_id,idempotency_key),
 FOREIGN KEY(source_cart_id,guest_id) REFERENCES carts(id,guest_id) ON DELETE RESTRICT,
 CHECK(expires_at>created_at), CHECK(cart_version BETWEEN 1 AND 9007199254740991),
 CHECK(shipping_address IS NULL OR jsonb_typeof(shipping_address)='object'),
 CHECK((state='known_order')=(order_id IS NOT NULL)),
 CHECK(state<>'prepared' OR (source_cart_id IS NOT NULL AND cart_version IS NOT NULL AND payment_scenario IS NOT NULL
 AND payload_hash IS NOT NULL AND contact_digest IS NOT NULL AND contact_email IS NOT NULL AND shipping_address IS NOT NULL)),
 CHECK(state NOT IN ('retired','expired') OR (contact_email IS NULL AND shipping_address IS NULL))
);
CREATE UNIQUE INDEX guest_one_prepared_intent ON guest_checkout_intents(guest_id) WHERE state='prepared';
CREATE INDEX guest_intent_expiry ON guest_checkout_intents(expires_at);

GRANT SELECT ON guest_principals,guest_sessions,guest_cart_choices,guest_checkout_intents TO ecom_app;
GRANT INSERT(id), UPDATE(updated_at) ON guest_principals TO ecom_app;
GRANT INSERT(id,guest_id,token_hash,expires_at), UPDATE(revoked_at) ON guest_sessions TO ecom_app;
GRANT INSERT(id,guest_id) ON carts TO ecom_app;
GRANT INSERT(session_id,user_id,guest_id,choice,guest_version,account_version,resulting_guest_version,resulting_account_version),
 UPDATE(choice,guest_version,account_version,resulting_guest_version,resulting_account_version,updated_at) ON guest_cart_choices TO ecom_app;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM guest_principals) OR EXISTS(SELECT 1 FROM carts WHERE guest_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM guest_sessions) OR EXISTS(SELECT 1 FROM guest_cart_choices)
 OR EXISTS(SELECT 1 FROM guest_checkout_intents) THEN
  RAISE EXCEPTION 'guest data exists; use a compatible binary or an approved restore';
 END IF;
END $$;
-- +goose StatementEnd
DROP TABLE guest_checkout_intents;
DROP TABLE guest_cart_choices;
ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_id_user;
ALTER TABLE carts DROP CONSTRAINT carts_id_guest;
ALTER TABLE carts DROP CONSTRAINT carts_id_user;
ALTER TABLE carts DROP CONSTRAINT carts_one_owner;
REVOKE INSERT(id,guest_id) ON carts FROM ecom_app;
ALTER TABLE carts DROP COLUMN guest_id;
ALTER TABLE carts ALTER COLUMN user_id SET NOT NULL;
-- Regrant the existing account-cart column permission revoked above.
GRANT INSERT(id,user_id) ON carts TO ecom_app;
DROP TABLE guest_sessions;
DROP TABLE guest_principals;
