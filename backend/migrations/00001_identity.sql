-- +goose Up
CREATE TABLE users (
 id uuid PRIMARY KEY, first_name text NOT NULL CHECK (length(trim(first_name))>0),
 last_name text NOT NULL CHECK (length(trim(last_name))>0),
 email text NOT NULL UNIQUE CHECK (email=lower(btrim(email)) AND length(email)>3),
 password_hash text NOT NULL, role text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 refresh_token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, last_used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 label text, recipient_name text NOT NULL, line_1 text NOT NULL, line_2 text,
 city text NOT NULL, region text NOT NULL, postal_code text NOT NULL,
 country_code char(2) NOT NULL DEFAULT 'US' CHECK (country_code='US'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_expiry ON user_sessions(user_id,expires_at);

CREATE INDEX addresses_user ON addresses(user_id);

-- +goose Down
DROP TABLE addresses;
DROP TABLE user_sessions;
DROP TABLE users;
