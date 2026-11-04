-- name: UpdateProfile :one
UPDATE users SET first_name = COALESCE(sqlc.narg(first_name)::text, first_name),
 last_name = COALESCE(sqlc.narg(last_name)::text, last_name), updated_at = now()
WHERE id = $1
RETURNING id, first_name, last_name, email, role, created_at, email_verified_at;

-- name: ListAddresses :many
SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at, id;

-- name: CreateAddress :one
INSERT INTO addresses (id, user_id, label, recipient_name, line_1, line_2, city, region, postal_code, country_code)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'US') RETURNING *;

-- name: UpdateAddress :one
UPDATE addresses SET
 label = CASE WHEN sqlc.arg(set_label)::boolean THEN sqlc.narg(label)::text ELSE label END,
 recipient_name = COALESCE(sqlc.narg(recipient_name)::text, recipient_name),
 line_1 = COALESCE(sqlc.narg(line_1)::text, line_1),
 line_2 = CASE WHEN sqlc.arg(set_line_2)::boolean THEN sqlc.narg(line_2)::text ELSE line_2 END,
 city = COALESCE(sqlc.narg(city)::text, city),
 region = COALESCE(sqlc.narg(region)::text, region),
 postal_code = COALESCE(sqlc.narg(postal_code)::text, postal_code), updated_at = now()
WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id) RETURNING *;

-- name: DeleteAddress :execrows
DELETE FROM addresses WHERE id = $1 AND user_id = $2;
