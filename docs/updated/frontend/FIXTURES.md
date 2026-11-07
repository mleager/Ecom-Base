# Fixtures

Reproducible demo data in its own disposable database. A fixture never seeds or resets the development database.

## Commands

```bash
bash scripts/dev.sh fixtures                  # create; prints a new ecom_fixture_<16 hex> ID
bash scripts/dev.sh fixture-check <id>        # verify ownership, schema and private files
bash scripts/dev.sh fixture-run <id>          # run the API against that database
bash scripts/dev.sh fixture-remove <id>       # drop the database and delete its private files
```

`scripts/fixture.sh` is a convenience wrapper: it reuses an existing fixture or creates one.

Requirements: `APP_ENV=local`, local PostgreSQL running, and the bootstrap roles from `.env`. Creating a fixture refuses remote or production targets.

`fixture-run` uses the root `HTTP_ADDR` (default `127.0.0.1:8080`) and `FRONTEND_ORIGIN`. Stop any other API on that port first.

## Data (version 1)

The source of truth is [`fixtures/catalog.v1.json`](../../../fixtures/catalog.v1.json). It has 36 products (34 active, 2 retired) with stable keys and UUIDs, and no orders or sessions.

| Case | Products |
|---|---|
| Normal browsing | `lamp_*`, `backpack_*`, `mug_*`, `bottle_*`: 6 of each, 50 units each |
| Search past page 1 | `late_search` (SKU `NEEDLE-SEARCH`, "Zulu Search Backpack") |
| Unicode and literal search | `unicode` ("Café Reading Lamp"), `literal_search` (name contains `%`, `_`, `!` and a backslash) |
| Pagination ties | `tie_one`, `tie_two`: same name, different UUIDs |
| Price and stock edges | `zero_stock`, `zero_price`, `maximum_price` (1,000,000,000,000 cents) |
| Image failures | `no_image` (no URL), `broken_image` (missing file) |
| Retired | `retired`, `retired_second`: visible only to admins |

| Account | Role | Starting data |
|---|---|---|
| `customer_one` | customer | One address, empty cart |
| `customer_two` | customer | One address; cart at version 4 with a normal line, a maximum-price line (quantity 10,000) and a retired line |
| `admin` | admin | Empty cart, no address |

Emails use `@example.test`. **Passwords are random for every fixture** and stored only in the private bundle.

## Private files

Each fixture writes to `.cache/fixtures/<id>/` (git-ignored, mode 0600):

- `metadata.json`: database name, server and an ownership marker
- `bundle.json`: account IDs, emails, passwords and API settings
- `api.env`: runtime-only settings for `fixture-run`, including a new JWT secret

Read the bundle locally to sign in. **Never copy its contents into docs, logs, browser assets or images.**

## Images

Original SVGs are in [`fixtures/public/fixtures/v1/`](../../../fixtures/public/fixtures/v1). Vite serves `fixtures/public` as its public directory, so URLs look like `/fixtures/v1/<name>.svg`. The fallback image is `/fixtures/v1/unavailable.svg`. The catalog JSON and private bundles are outside the public tree.

## Lifecycle rules

- Create a new fixture to get a clean baseline. Fixtures are meant to be changed through the app.
- `remove` checks the server, the owner (`ecom_migrator`) and the exact marker before dropping. It force-closes that database's connections, so stop its API first.
- If a create fails, remove that ID and create a new one. Never resume a half-built fixture.
- Changing the catalog or image bytes changes the dataset digest, so old bundles fail `check`.

The browser test harness creates and removes one fixture **per test**. See [TESTING.md](TESTING.md).
