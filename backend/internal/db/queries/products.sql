-- name: ListProducts :many
SELECT p.id, p.sku, p.name, p.description, p.image_url, p.unit_price_cents,
       p.is_active, (i.quantity_on_hand - i.quantity_reserved)::integer AS available_quantity
FROM products AS p
JOIN inventory AS i ON i.product_id = p.id
WHERE p.is_active = true
 AND (sqlc.arg(search_pattern)::text = ''
  OR p.name ILIKE sqlc.arg(search_pattern)::text ESCAPE '!'
  OR p.sku ILIKE sqlc.arg(search_pattern)::text ESCAPE '!')
ORDER BY p.name, p.id
LIMIT sqlc.arg(page_limit)::bigint OFFSET sqlc.arg(page_offset)::bigint;

-- name: GetProduct :one
SELECT p.id, p.sku, p.name, p.description, p.image_url, p.unit_price_cents,
       p.is_active, (i.quantity_on_hand - i.quantity_reserved)::integer AS available_quantity
FROM products AS p
JOIN inventory AS i ON i.product_id = p.id
WHERE p.id = $1 AND p.is_active = true;

