-- +goose Up
CREATE TABLE carts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 1 CHECK (version>=1),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
 id uuid PRIMARY KEY, cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK (quantity>0),
 added_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (cart_id,product_id)
);

-- +goose Down
DROP TABLE cart_items;
DROP TABLE carts;
