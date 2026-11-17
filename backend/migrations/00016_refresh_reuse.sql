-- +goose Up
-- M17 task 9 (review M4): reuse of a rotated refresh token. Each session
-- keeps the previous token's verifier and when it was rotated. Presenting
-- it within 30 seconds is a race between tabs (401 only); later, the token
-- was copied, so the session is revoked for everyone holding it.
--
-- Expand only. The previous release rotates without setting these columns;
-- a session it rotated keeps an older previous verifier, whose reuse also
-- revokes, which is the intended outcome for an old token.
ALTER TABLE user_sessions ADD COLUMN previous_refresh_token_hash text, ADD COLUMN rotated_at timestamptz;
CREATE UNIQUE INDEX user_session_previous_refresh ON user_sessions(previous_refresh_token_hash)
 WHERE previous_refresh_token_hash IS NOT NULL;
GRANT UPDATE(previous_refresh_token_hash, rotated_at) ON user_sessions TO ecom_app;

-- +goose Down
REVOKE UPDATE(previous_refresh_token_hash, rotated_at) ON user_sessions FROM ecom_app;
DROP INDEX user_session_previous_refresh;
ALTER TABLE user_sessions DROP COLUMN rotated_at, DROP COLUMN previous_refresh_token_hash;
