-- name: RecoveryCutoff :one
SELECT transaction_timestamp()::timestamptz AS cutoff;

-- name: ReadRecoveryOrders :many
SELECT * FROM orders WHERE status = 'pending_payment' AND reservation_expires_at <= sqlc.arg(cutoff)
ORDER BY reservation_expires_at, id LIMIT sqlc.arg(visit_limit)::bigint;

-- name: NextRecoveryOrder :one
SELECT * FROM orders WHERE status = 'pending_payment' AND reservation_expires_at <= sqlc.arg(cutoff)
 AND (NOT sqlc.arg(has_cursor)::boolean OR (reservation_expires_at, id) > (sqlc.arg(cursor_time)::timestamptz, sqlc.arg(cursor_id)::uuid))
ORDER BY reservation_expires_at, id LIMIT 1 FOR UPDATE SKIP LOCKED;

-- name: ReadOrderReservations :many
SELECT r.* FROM inventory_reservations AS r JOIN order_items AS i ON i.id = r.order_item_id
WHERE i.order_id = $1 ORDER BY r.product_id;

-- name: RecoveryDiagnostics :many
WITH problems AS (
 SELECT 'inventory_aggregate'::text AS code, 'product'::text AS entity_type, p.id AS entity_id
 FROM products AS p LEFT JOIN inventory AS v ON v.product_id = p.id
 LEFT JOIN (SELECT product_id, sum(quantity)::bigint AS held FROM inventory_reservations WHERE status = 'active' GROUP BY product_id) AS r ON r.product_id = p.id
 WHERE v.product_id IS NULL OR v.quantity_reserved <> coalesce(r.held, 0)
 UNION ALL
 SELECT 'order_totals', 'order', o.id FROM orders AS o
 LEFT JOIN (SELECT order_id, count(*) AS lines, sum(line_total_cents::numeric) AS total,
  bool_and(quantity BETWEEN 1 AND 10000 AND unit_price_cents BETWEEN 0 AND 1000000000000
   AND line_total_cents BETWEEN 0 AND 1000000000000
   AND line_total_cents::numeric = quantity::numeric * unit_price_cents::numeric) AS valid
  FROM order_items GROUP BY order_id) AS i ON i.order_id = o.id
 WHERE coalesce(i.lines, 0) NOT BETWEEN 1 AND 100 OR NOT coalesce(i.valid, false)
  OR i.total <> o.total_cents OR i.total <> o.subtotal_cents
  OR o.total_cents NOT BETWEEN 0 AND 1000000000000 OR o.currency <> 'USD'
 UNION ALL
 SELECT 'order_deadline', 'order', id FROM orders WHERE reservation_expires_at <> created_at + interval '15 minutes'
 UNION ALL
 SELECT 'reservation_missing', 'order', i.order_id FROM order_items AS i
 LEFT JOIN inventory_reservations AS r ON r.order_item_id = i.id WHERE r.id IS NULL
 UNION ALL
 SELECT 'reservation_link_or_state', 'order', i.order_id FROM inventory_reservations AS r
 JOIN order_items AS i ON i.id = r.order_item_id JOIN orders AS o ON o.id = i.order_id
 WHERE r.product_id <> i.product_id OR r.quantity <> i.quantity OR r.expires_at <> o.reservation_expires_at
  OR r.status <> CASE o.status WHEN 'pending_payment' THEN 'active' WHEN 'confirmed' THEN 'consumed'
   WHEN 'payment_failed' THEN 'released' WHEN 'cancelled' THEN 'released' ELSE 'invalid' END
 UNION ALL
 SELECT 'payment_cardinality', 'order', o.id FROM orders AS o
 LEFT JOIN payment_attempts AS p ON p.order_id = o.id GROUP BY o.id
 HAVING count(p.id) <> 1 OR min(p.attempt_number) <> 1
 UNION ALL
 SELECT 'payment_state', 'order', o.id FROM orders AS o JOIN payment_attempts AS p ON p.order_id = o.id
 WHERE p.simulator_reference <> p.id::text OR p.scenario NOT IN ('accept', 'reject') OR NOT CASE p.status
  WHEN 'pending' THEN o.status = 'pending_payment' AND p.started_at IS NULL AND p.completed_at IS NULL AND p.failure_code IS NULL
  WHEN 'processing' THEN o.status = 'pending_payment' AND p.started_at IS NOT NULL AND p.completed_at IS NULL AND p.failure_code IS NULL
  WHEN 'succeeded' THEN o.status = 'confirmed' AND p.scenario = 'accept' AND p.started_at IS NOT NULL AND p.completed_at IS NOT NULL AND p.completed_at >= p.started_at AND p.failure_code IS NULL
  WHEN 'failed' THEN o.status = 'payment_failed' AND p.scenario = 'reject' AND p.started_at IS NOT NULL AND p.completed_at IS NOT NULL AND p.completed_at >= p.started_at AND p.failure_code IS NOT NULL AND p.failure_code = 'simulated_decline'
  WHEN 'cancelled' THEN o.status = 'cancelled' AND p.started_at IS NULL AND p.completed_at IS NOT NULL AND p.failure_code IS NULL
  ELSE false END
), distinct_problems AS (SELECT DISTINCT code, entity_type, entity_id FROM problems)
SELECT code, entity_type, entity_id, count(*) OVER ()::bigint AS total_findings FROM distinct_problems
ORDER BY code, entity_type, entity_id LIMIT sqlc.arg(finding_limit)::bigint;
