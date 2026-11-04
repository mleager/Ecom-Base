-- Explicit migrator-only maintenance. Inspect candidates before executing.
-- Each mutation affects at most 500 rows, never settles financial work.
-- Execute through a client with a five-second transaction context/deadline.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='2s';
DO $$ BEGIN
 IF current_user<>'ecom_migrator' THEN RAISE EXCEPTION 'use the migrator role'; END IF;
END $$;
CREATE TEMP TABLE guest_cleanup_candidates ON COMMIT DROP AS
SELECT p.id FROM guest_principals p
WHERE p.created_at<clock_timestamp()-interval '37 days'
AND NOT EXISTS(SELECT 1 FROM guest_sessions s WHERE s.guest_id=p.id AND s.expires_at>=clock_timestamp()-interval '7 days')
AND NOT EXISTS(SELECT 1 FROM guest_checkout_intents i WHERE i.guest_id=p.id)
AND NOT EXISTS(SELECT 1 FROM carts c JOIN orders o ON o.source_cart_id=c.id WHERE c.guest_id=p.id)
ORDER BY p.id LIMIT 500 FOR UPDATE OF p SKIP LOCKED;
DELETE FROM guest_cart_choices WHERE (session_id,guest_id) IN
 (SELECT c.session_id,c.guest_id FROM guest_cart_choices c JOIN guest_cleanup_candidates p ON c.guest_id=p.id ORDER BY c.guest_id,c.session_id LIMIT 500);
DELETE FROM guest_sessions WHERE id IN
 (SELECT s.id FROM guest_sessions s JOIN guest_cleanup_candidates p ON s.guest_id=p.id
 WHERE s.expires_at<clock_timestamp()-interval '7 days' ORDER BY s.guest_id,s.id LIMIT 500);
DELETE FROM cart_items WHERE id IN
 (SELECT i.id FROM cart_items i JOIN carts c ON i.cart_id=c.id JOIN guest_cleanup_candidates p ON c.guest_id=p.id ORDER BY c.guest_id,i.id LIMIT 500);
DELETE FROM carts c USING guest_cleanup_candidates p WHERE c.guest_id=p.id
 AND NOT EXISTS(SELECT 1 FROM cart_items i WHERE i.cart_id=c.id);
DELETE FROM guest_principals g USING guest_cleanup_candidates p WHERE g.id=p.id
 AND NOT EXISTS(SELECT 1 FROM carts c WHERE c.guest_id=g.id)
 AND NOT EXISTS(SELECT 1 FROM guest_sessions s WHERE s.guest_id=g.id)
 AND NOT EXISTS(SELECT 1 FROM guest_cart_choices c WHERE c.guest_id=g.id);
-- Every preparation/checkout/retirement locks its principal before touching
-- intent state. These locks fence cleanup against a concurrent T1.
WITH expired AS MATERIALIZED (
 SELECT p.id FROM guest_principals p JOIN guest_checkout_intents i ON i.guest_id=p.id
 WHERE i.state='prepared' AND i.expires_at<=clock_timestamp()
 ORDER BY p.id LIMIT 500 FOR UPDATE OF p SKIP LOCKED
)
UPDATE guest_checkout_intents i SET state='expired',contact_email=NULL,shipping_address=NULL
FROM expired p WHERE i.guest_id=p.id AND i.state='prepared' AND i.expires_at<=clock_timestamp();
DELETE FROM guest_recovery_tokens WHERE id IN (
 SELECT id FROM guest_recovery_tokens WHERE expires_at<clock_timestamp()-interval '7 days'
 ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED
);
DELETE FROM guest_recovery_sessions WHERE id IN (
 SELECT id FROM guest_recovery_sessions WHERE expires_at<clock_timestamp()-interval '7 days'
 ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED
);
COMMIT;
