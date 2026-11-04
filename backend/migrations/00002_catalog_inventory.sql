-- +goose Up
CREATE TABLE products (
 id uuid PRIMARY KEY, sku text NOT NULL UNIQUE, name text NOT NULL,
 description text, image_url text,
 unit_price_cents bigint NOT NULL CHECK (unit_price_cents>=0),
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory (
 product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
 quantity_on_hand integer NOT NULL DEFAULT 0 CHECK (quantity_on_hand>=0),
 quantity_reserved integer NOT NULL DEFAULT 0 CHECK (quantity_reserved>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT inventory_within_stock CHECK (quantity_reserved<=quantity_on_hand)
);

CREATE INDEX products_active_name ON products(is_active,name);

-- +goose Down
DROP TABLE inventory;
DROP TABLE products;
