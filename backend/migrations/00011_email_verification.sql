-- +goose Up
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

CREATE TABLE email_change_requests (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 old_email text NOT NULL CHECK (old_email=lower(btrim(old_email)) AND length(old_email)>3),
 new_email text NOT NULL CHECK (new_email=lower(btrim(new_email)) AND length(new_email)>3),
 credential_version bigint NOT NULL CHECK (credential_version>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 old_confirmed_at timestamptz, new_confirmed_at timestamptz, finished_at timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','cancelled','expired','conflict')),
 UNIQUE(id,user_id), CHECK(old_email<>new_email), CHECK(expires_at>created_at),
 CHECK((state='pending')=(finished_at IS NULL)),
 CHECK(state<>'completed' OR (old_confirmed_at IS NOT NULL AND new_confirmed_at IS NOT NULL)),
 CHECK(state<>'pending' OR old_confirmed_at IS NULL OR new_confirmed_at IS NULL)
);
CREATE UNIQUE INDEX email_change_pending_user ON email_change_requests(user_id) WHERE state='pending';
CREATE INDEX email_change_expiry ON email_change_requests(expires_at);

CREATE TABLE account_security_tokens (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 purpose text NOT NULL CHECK(purpose IN ('verify_email','reset_password','email_change_old','email_change_new')),
 email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email)>3),
 credential_version bigint NOT NULL CHECK(credential_version>=0), change_request_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, invalidated_at timestamptz,
 FOREIGN KEY(change_request_id,user_id) REFERENCES email_change_requests(id,user_id) ON DELETE CASCADE,
 CHECK(expires_at>created_at), CHECK(consumed_at IS NULL OR invalidated_at IS NULL),
 CHECK((purpose IN ('email_change_old','email_change_new'))=(change_request_id IS NOT NULL)),
 UNIQUE(change_request_id,purpose)
);
CREATE UNIQUE INDEX verification_active_user ON account_security_tokens(user_id,purpose)
 WHERE purpose='verify_email' AND consumed_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX security_token_user_issuance ON account_security_tokens(user_id,purpose,created_at);
CREATE INDEX security_token_expiry ON account_security_tokens(expires_at);

GRANT UPDATE(email,email_verified_at) ON users TO ecom_app;
GRANT SELECT ON account_security_tokens,email_change_requests TO ecom_app;
GRANT INSERT(id,user_id,token_hash,purpose,email,credential_version,change_request_id,expires_at) ON account_security_tokens TO ecom_app;
GRANT UPDATE(consumed_at,invalidated_at) ON account_security_tokens TO ecom_app;
GRANT INSERT(id,user_id,old_email,new_email,credential_version,expires_at) ON email_change_requests TO ecom_app;
GRANT UPDATE(old_confirmed_at,new_confirmed_at,finished_at,state) ON email_change_requests TO ecom_app;

-- +goose Down
REVOKE UPDATE(email,email_verified_at) ON users FROM ecom_app;
DROP TABLE account_security_tokens;
DROP TABLE email_change_requests;
ALTER TABLE users DROP COLUMN email_verified_at;
