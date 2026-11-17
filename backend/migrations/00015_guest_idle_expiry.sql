-- +goose Up
-- M17 task 8 (review M2): a guest session expires after 7 days without use
-- and after 30 days at most. expires_at becomes the idle deadline, which
-- every existing check already enforces, and use moves it forward (at most
-- once an hour). absolute_expires_at keeps the 30-day limit.
--
-- Expand only. The previous release keeps inserting rows without the new
-- column and never updates expires_at; NULL means expires_at is also the
-- absolute deadline, so such sessions keep their fixed 30 days.
ALTER TABLE guest_sessions ADD COLUMN absolute_expires_at timestamptz;
ALTER TABLE guest_sessions ADD CONSTRAINT guest_session_absolute_deadline
 CHECK (absolute_expires_at IS NULL OR absolute_expires_at >= expires_at);
GRANT INSERT(absolute_expires_at), UPDATE(expires_at) ON guest_sessions TO ecom_app;

-- +goose Down
-- Dropping the column loses no session: expires_at stays enforced.
REVOKE INSERT(absolute_expires_at), UPDATE(expires_at) ON guest_sessions FROM ecom_app;
ALTER TABLE guest_sessions DROP CONSTRAINT guest_session_absolute_deadline;
ALTER TABLE guest_sessions DROP COLUMN absolute_expires_at;
