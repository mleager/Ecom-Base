-- name: CreateProduct :one
INSERT INTO products (id, sku, name, description, image_url, unit_price_cents)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: CreateInventory :exec
INSERT INTO inventory (product_id) VALUES ($1);

-- name: UpdateProduct :one
UPDATE products SET
 sku = COALESCE(sqlc.narg(sku)::text, sku), name = COALESCE(sqlc.narg(name)::text, name),
 description = CASE WHEN sqlc.arg(set_description)::boolean THEN sqlc.narg(description)::text ELSE description END,
 image_url = CASE WHEN sqlc.arg(set_image_url)::boolean THEN sqlc.narg(image_url)::text ELSE image_url END,
 unit_price_cents = COALESCE(sqlc.narg(unit_price_cents)::bigint, unit_price_cents),
 is_active = COALESCE(sqlc.narg(is_active)::boolean, is_active), updated_at = now()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: RetireProduct :execrows
UPDATE products SET is_active = false, updated_at = now() WHERE id = $1;

-- name: GetInventory :one
SELECT * FROM inventory WHERE product_id = $1;

-- name: ListAdminProducts :many
SELECT sqlc.embed(p), i.product_id AS inventory_product_id,
 COALESCE(i.quantity_on_hand - i.quantity_reserved, 0)::integer AS available_quantity
FROM products AS p
LEFT JOIN inventory AS i ON i.product_id = p.id
WHERE (sqlc.narg(is_active)::boolean IS NULL OR p.is_active = sqlc.narg(is_active)::boolean)
AND (sqlc.arg(search_pattern)::text = '' OR p.name ILIKE sqlc.arg(search_pattern)::text ESCAPE '!'
 OR p.sku ILIKE sqlc.arg(search_pattern)::text ESCAPE '!')
ORDER BY p.name, p.id
LIMIT sqlc.arg(page_limit)::bigint OFFSET sqlc.arg(page_offset)::bigint;

-- name: GetAdminProduct :one
SELECT sqlc.embed(p), i.product_id AS inventory_product_id,
 COALESCE(i.quantity_on_hand - i.quantity_reserved, 0)::integer AS available_quantity
FROM products AS p
LEFT JOIN inventory AS i ON i.product_id = p.id
WHERE p.id = $1;

-- name: GetAdminInventory :one
SELECT p.id AS product_id, i.product_id AS inventory_product_id,
 COALESCE(i.quantity_on_hand, 0)::integer AS quantity_on_hand,
 COALESCE(i.quantity_reserved, 0)::integer AS quantity_reserved
FROM products AS p
LEFT JOIN inventory AS i ON i.product_id = p.id
WHERE p.id = $1;

-- name: LockInventory :one
SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE;

-- name: SetOnHand :one
UPDATE inventory SET quantity_on_hand = $2, updated_at = now()
WHERE product_id = $1 RETURNING *;
