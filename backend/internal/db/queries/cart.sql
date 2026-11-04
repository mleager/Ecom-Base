-- name: LockCart :one
SELECT * FROM carts WHERE user_id = $1 FOR UPDATE;

-- name: ReadLockCart :one
SELECT * FROM carts WHERE user_id = $1 FOR SHARE;

-- name: ListCartItems :many
SELECT * FROM cart_items WHERE cart_id = $1 ORDER BY added_at, id;

-- name: ActiveCartProduct :one
SELECT id FROM products WHERE id = $1 AND is_active = true FOR SHARE;

-- name: InsertCartItem :exec
INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES ($1, $2, $3, $4);

-- name: SetCartQuantity :exec
UPDATE cart_items SET quantity = $3, updated_at = now() WHERE id = $1 AND cart_id = $2;

-- name: DeleteCartItem :exec
DELETE FROM cart_items WHERE id = $1 AND cart_id = $2;

-- name: ClearCart :exec
DELETE FROM cart_items WHERE cart_id = $1;

-- name: IncrementCartVersion :one
UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version;
