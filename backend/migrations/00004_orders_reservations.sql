-- +goose Up
CREATE TABLE orders (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK (status IN ('pending_payment','confirmed','payment_failed','cancelled')),
 subtotal_cents bigint NOT NULL CHECK (subtotal_cents>=0),
 total_cents bigint NOT NULL CHECK (total_cents>=0),
 currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
 shipping_address jsonb NOT NULL CHECK (jsonb_typeof(shipping_address)='object'),
 source_cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE RESTRICT,
 source_cart_version bigint NOT NULL CHECK (source_cart_version>=1),
 reservation_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (source_cart_id,source_cart_version),
 CONSTRAINT project1_totals CHECK (total_cents=subtotal_cents)
);

CREATE TABLE order_items (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
 sku_snapshot text NOT NULL, product_name_snapshot text NOT NULL,
 quantity integer NOT NULL CHECK (quantity>0),
 unit_price_cents bigint NOT NULL CHECK (unit_price_cents>=0),
 line_total_cents bigint NOT NULL CHECK (line_total_cents>=0),
 UNIQUE (order_id,product_id),
 CHECK (line_total_cents = quantity::bigint * unit_price_cents)
);

CREATE TABLE inventory_reservations (
 id uuid PRIMARY KEY,
 order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE RESTRICT,
 product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK (quantity>0),
 status text NOT NULL CHECK (status IN ('active','consumed','released')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_customer_recent ON orders(user_id,created_at DESC);

CREATE INDEX orders_pending_expiry ON orders(reservation_expires_at) WHERE status='pending_payment';

CREATE INDEX order_items_order ON order_items(order_id);

CREATE INDEX reservations_by_status_expiry ON inventory_reservations(status,expires_at);

CREATE INDEX reservations_product_active ON inventory_reservations(product_id) WHERE status='active';

-- +goose Down
DROP TABLE inventory_reservations;
DROP TABLE order_items;
DROP TABLE orders;
