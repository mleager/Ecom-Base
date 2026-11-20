# Fixtures

Reproducible demo data in its own disposable database. A fixture never seeds or resets the development database.

**Design:** one versioned catalog (`catalog.v1.json`) covers the edge cases the UI must handle: search past page one, Unicode, literal `%` and `_`, ties in sort order, zero and maximum prices, missing images and retired products. Each fixture gets random passwords that are kept only in an ignored, private bundle. Fixtures are cloned from a migrated template database, so the browser harness can create one per test without running every migration again.

## Commands

All fixture commands are in `scripts/fixture.sh`:

```bash
bash scripts/fixture.sh create                # create; prints a new ecom_fixture_<16 hex> ID
bash scripts/fixture.sh create --https        # create one for https://localhost:8443
bash scripts/fixture.sh list                  # IDs and origins; marks incomplete folders
bash scripts/fixture.sh check [id]            # verify ownership, schema and private files
bash scripts/fixture.sh run [id]              # run the API against that database (HTTP)
bash scripts/fixture.sh serve [id]            # serve the built frontend and the API on https://localhost:8443
bash scripts/fixture.sh psql [id] [psql args] # psql on the fixture database as ecom_app
bash scripts/fixture.sh remove [id] [--yes]   # drop the database and delete its private files (asks first)
```

`[id]` is a full ID or a unique prefix (for example `5d5e`). Without one, the only complete fixture is used; with several, an interactive terminal shows a numbered list and anything else must pass an ID. `remove` asks for confirmation unless `--yes` is given.

Requirements: `APP_ENV=local`, local PostgreSQL running, and the bootstrap roles from `.env`. Creating a fixture refuses remote or production targets.

`run` uses the `HTTP_ADDR` and `FRONTEND_ORIGIN` recorded in the fixture's `api.env`, taken from the root `.env` when it was created (default `127.0.0.1:8080` and `http://localhost:5173`). Stop any other API on that port first.

## Data (version 1)

The source of truth is [`fixtures/catalog.v1.json`](../../fixtures/catalog.v1.json). It has 36 products (34 active, 2 retired) with stable keys and UUIDs, and no orders or sessions.

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
- `api.env`: runtime-only settings for `fixture.sh run` and `serve`, including a new JWT secret

Read the bundle locally to sign in. **Never copy its contents into docs, logs, browser assets or images.**

## Images

Original SVGs are in [`fixtures/public/fixtures/v1/`](../../fixtures/public/fixtures/v1). Vite serves `fixtures/public` as its public directory, so URLs look like `/fixtures/v1/<name>.svg`. The fallback image is `/fixtures/v1/unavailable.svg`. The catalog JSON and private bundles are outside the public tree.

## Lifecycle rules

- Create a new fixture to get a clean baseline. Fixtures are meant to be changed through the app.
- `remove` checks the server, the owner (`ecom_migrator`) and the exact marker before dropping. It force-closes that database's connections, so stop its API first.
- If a create fails, remove that ID and create a new one. Never resume a half-built fixture.
- Changing the catalog or image bytes changes the dataset digest, so old bundles fail `check`.

The browser test harness creates and removes one fixture **per test**. See [TESTING.md](TESTING.md).

## Migration template

`create` does not run goose for every fixture. It clones a migrated template database instead:

- **Name.** `ecom_fixture_template_<first 16 hex of a digest>`, owned by `ecom_migrator`. The digest covers every file name and file content in `backend/migrations`, plus a template format number, so any migration change selects a new template.
- **Build.** When the template is missing, `create` builds it under a PostgreSQL advisory lock; concurrent creates wait and reuse it. It creates the database, applies the runtime grants and goose migrations, then disallows connections, marks it as a template and records the comment `ecom-fixtures-template:v1:<digest>`. An interrupted build stays marked `:building`, and the next `create` rebuilds it.
- **Use.** Each fixture is `CREATE DATABASE <fixture> TEMPLATE <template> OWNER ecom_migrator`, followed by its own ownership marker and seed (catalog, accounts, passwords, JWT secret, addresses, carts). Fixtures still share no data or secrets.
- **Cleanup.** After building a new template, `create` drops other owned `v1` templates on a best-effort basis. Template names never match the `ecom_fixture_<16 hex>` pattern, so `check` and `remove` cannot target them. To drop one by hand, stop all fixture work, then as the local administrator run `ALTER DATABASE <name> WITH IS_TEMPLATE false` and `DROP DATABASE <name>`; the next `create` rebuilds it.
