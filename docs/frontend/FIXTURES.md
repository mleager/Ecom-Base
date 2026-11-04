# Versioned local fixtures

**Implemented:** 2026-10-21, Milestone 6 task 5. Fixture version **1**, schema **9**. The [catalog manifest](../../fixtures/catalog.v1.json) is the authority for product keys, UUIDs, content, prices, stock and activity. Public images are original repository-owned SVG illustrations in [fixtures/public/fixtures/v1](../../fixtures/public/fixtures/v1); they use no external fonts, scripts, image downloads or CDN.

## Create and use a fixture

Run from the repository root after the existing [local PostgreSQL/bootstrap setup](../backend/OPERATIONS.md#first-setup-and-routine-restart). Use installed Go/goose; Docker runs PostgreSQL only. The command requires `APP_ENV=local`, the loopback PostgreSQL administrator and the existing `ecom_migrator`/`ecom_app` roles/passwords from ignored root `.env`. It refuses production/remote targets and connection-host overrides.

| Action | PowerShell | Bash |
|---|---|---|
| Create a fresh dataset | `./scripts/dev.ps1 fixtures` | `bash scripts/dev.sh fixtures` |
| Validate a returned fixture ID | `./scripts/dev.ps1 fixture-check -Fixture <id>` | `bash scripts/dev.sh fixture-check <id>` |
| Run the API against that dataset | `./scripts/dev.ps1 fixture-run -Fixture <id>` | `bash scripts/dev.sh fixture-run <id>` |
| Remove that owned dataset and credential files intentionally | `./scripts/dev.ps1 fixture-remove -Fixture <id>` | `bash scripts/dev.sh fixture-remove <id>` |

Replace `<id>` with the returned `ecom_fixture_` identifier; it is an argument, not literal shell angle-bracket syntax. Native command equivalents are `go run ./backend/cmd/fixtures create`, `check <id>` and `remove <id>` with explicit process configuration. The scripts supply that configuration without printing it.

Create always selects a fresh random database name. It applies local goose migrations, inserts the versioned catalog/inventory, uses existing registration/Argon2id logic for three new accounts, creates owned addresses/carts and provisions only its newly created admin. It never seeds/resets an existing database, overwrites a bundle, changes development roles, deletes the development volume or runs as part of API startup. Creating again reproduces catalog IDs/content in another database with independent account passwords/JWT secret; it is not a reset of the first instance.

Output contains only action, fixture ID and version. Private files live in ignored `.cache/fixtures/<id>/`:

- `metadata.json`: database name, local server and random database ownership marker; also retained for incomplete setup.
- `bundle.json`: version/content digest, API configuration and per-run account IDs/emails/passwords/roles/address IDs. Inspect locally when signing in; never copy it into documentation, browser assets or shared logs.
- `api.env`: runtime-only API settings consumed literally by `fixture-run`; it uses the runtime role and a new JWT secret, not the database administrator. Check verifies this file matches the private bundle before use.

Files are created exclusively with mode 0600 and directories with 0700 on platforms supporting those modes; Windows access follows the workspace's inherited ACLs. Keep the workspace/cache private. No account has a default or documented password. The secret files are not release artifacts and must stay outside images/source control.

`fixture-run` validates ownership/schema, loads the generated API environment in its process and invokes the existing API command. Root `.env` is unchanged. Use Ctrl+C to stop it; an occupied configured port fails normally. It uses root configuration's HTTP address (default 127.0.0.1:8080) and frontend origin (default `http://localhost:5173`); stop your other API process or select a different local configuration before using that address. The frontend must call the selected API URL with a matching browser hostname.

## Dataset and public images

| Case | Stable catalog keys / baseline |
|---|---|
| Normal browsing | Six variants each of `lamp_*`, `backpack_*`, `mug_*`, `bottle_*`: 24 active products with 50 units each. |
| Search beyond page one | `late_search`, SKU `NEEDLE-SEARCH`, name `Zulu Search Backpack`. |
| Unicode/literal matching | `unicode` (`Café Reading Lamp`), `literal_search` (name contains `%`, `_`, `!` and backslash). |
| Stable pagination ties | `tie_one`, `tie_two`: identical names with distinct fixed UUIDs. |
| Availability/pricing | `zero_stock`, `zero_price`, `maximum_price` (1,000,000,000,000 cents). |
| Image failures | `no_image` has no URL; `broken_image` uses intentionally absent `missing.svg`. |
| Retired products | `retired`, `retired_second`; discoverable only through admin reads, absent from public reads/search. |

There are **36 products: 34 active and two retired**, with zero reserved units, no orders/payment attempts/reservations and no preauthenticated sessions. Prices and stock are synthetic demonstration data, not real inventory or charges.

| Account key | Email / role | Initial owned data |
|---|---|---|
| `customer_one` | `customer.one@example.test`, customer | One US address, empty cart; useful for a normal shopping flow. |
| `customer_two` | `customer.two@example.test`, customer | One different owned US address; version-4 cart with a normal line (quantity 2), maximum-price line (quantity 10,000) and retained retired line (quantity 1). Exercises incomplete/out-of-range estimates and independent removal. |
| `admin` | `admin@example.test`, administrator | Empty cart; no saved address. Product/stock administration is server-enforced. |

Account/address/cart IDs and password verifiers vary per setup; the private bundle supplies their identities. Product keys/UUIDs and initial business data are stable. All passwords and salts are generated independently; successful login creates normal sessions. The dataset is intentionally mutable through the application. `check` verifies provenance, matching private configuration, local target, owner/marker and schema, not pristine business state. To restore baseline, create another fixture; remove the old one only when finished.

Product image URLs use the configured frontend origin plus `/fixtures/v1/<image>.svg`. The data manifest and private credentials are outside the public asset directory. In M7, set Vite's `publicDir` to `../fixtures/public`; Vite can then serve/copy these files unchanged without a new image service or backend domain endpoint. Use `/fixtures/v1/unavailable.svg` as the image fallback. M14 packages the resulting public build, never the fixture bundles.

The SVG source/HTTP availability and controlled missing-image response are tested through a temporary Go HTTP server. M7 configures Vite's public directory and verifies that the build copies all five public SVGs byte-for-byte, excluding catalog metadata/private bundles. M8 [catalog acceptance](TEST_PLAN.md#milestone-8-acceptance) verifies real browser image loading/fallback; packaged serving remains M14. Changing catalog or image bytes changes the saved SHA-256 dataset identity; an old bundle cannot pass `check` against changed fixture source. Version/catalog changes must be reviewed alongside the manifest, source package and fixture tests.

## Failure handling and removal

Removal accepts only a recorded `ecom_fixture_<16 hex>` name and validates the current local server, `ecom_migrator` ownership and exact database comment marker before dropping it. It force-closes that fixture's remaining database connections; stop its API/test process first. It deletes only the three known bundle files and the now-empty exact directory, never recursively removes an arbitrary path, and retains a nonempty directory for inspection. Unknown/missing bundles and marker mismatches fail without deleting a database. Older-version ownership metadata can still be used for removal.

A failed create retains the generated ID/checkpoint but is not runnable until both private output files exist. If ownership was recorded, remove that ID and create a fresh fixture; do not resume/reseed a partially initialized database. If CREATE DATABASE acknowledgement or comment creation failed, removal may refuse an unmarked database: inspect the reported exact name/owner with your local administrator before taking a deliberate cleanup action. A failed write/drop never proves rollback. No development database or volume reset is part of recovery.

Current browser harness: native executables are reused only within one worker/run; each test still creates and removes its own marker-owned database, credentials/private bundle and API process. Worker executables remain available until all per-test cleanup completes; any process/database cleanup failure retains them. Only known files in the owned worker directory are removed at shutdown, with no sweep of older output. Interrupted/failed-cleanup recovery continues to use the removal procedure above. See [lifecycle/timing policy](TOOLING.md#browser-harness-execution) and [isolation evidence](TEST_PLAN.md#harness-performance-and-isolation-progress). Dated evidence below describes the implementation at that time.

## Administrator authorization controls — Milestone 11 task 8

The integration-only browser control accepts `expire-session`, `session-expiry` and `deactivate` for the named `admin` or `customer_one` fixture account. `near-cart-version-limit` remains customer-one-only and `demote` remains admin-only; customer two, arbitrary IDs/accounts, SQL, values and malformed input are refused. Controls inspect the private bundle/current local configuration and recheck the ownership marker on the actual target connection before a bounded query, requiring exactly one row for mutations. They affect only disposable marker-owned fixtures, are absent from production API/CLI binaries and never change host/PostgreSQL clock settings. The expiry inspector verifies that refresh does not extend the fixed session lifetime. [Consolidated authorization evidence](TEST_PLAN.md#milestone-11-administrator-authorization-progress) owns executed proof; the allowlist change requires full browser regression.

## Executed evidence

M7 reuses this workflow from Playwright: each authenticated test creates a fresh dataset with native Go/goose and runs an isolated API on port 18080. Teardown stops that process before marker-protected removal; per-test isolation prevents shared limiter/session state. All 33 Chromium checks pass, including negative server policy, expired JWT/session, inactive accounts and database role demotion alongside auth/session/route regressions. Integration-only test controls revalidate the marker/configuration and restrict changes to named fixture accounts; production CLI/API behavior is unchanged. Owned databases/private bundles were removed. See [application commands](../../frontend/README.md) and [acceptance mapping](TEST_PLAN.md#milestone-7-acceptance); shopping features still require their own isolation checks.

Harness maintenance (2026-10-24): after successful process and fixture cleanup, teardown also removes that test's compiled executables and empty `.cache/frontend-e2e/<id>` directory. The same cleanup runs after a failed test/setup. Failed process/fixture cleanup preserves the executables; unexpected files are retained and reported as a cleanup failure. This does not sweep older output or manually created fixture bundles. See [current verification](TEST_PLAN.md#harness-cleanup-verification).

M9 acceptance adds `near-cart-version-limit` to the integration-only browser control: it accepts only `customer_one`, rechecks the local fixture marker/credentials on the target connection and sets one cart to the fixed value 9007199254740990. It cannot select arbitrary SQL, accounts or values and is absent from production binaries/routes. A separate full-capacity journey creates additional products through the existing admin API and fills only its disposable customer's cart; version-1 source data/bundle format remain unchanged. The existing private auth-clock control and Playwright clock model a security-throttle wait, without changing PostgreSQL expiry or host time. [Acceptance evidence](TEST_PLAN.md#milestone-9-acceptance) records the scope.

`TestFixtureWorkflow` creates two fresh fixture databases with local goose, checks stable content/independent secrets, logs in all three accounts, verifies admin/customer and address isolation, catalog/search data and retained-cart removal. It refuses marker/config tampering, removes a partially created owned fixture and verifies an existing sentinel database's data remains unchanged. All test-owned bundles/databases are cleaned up. `TestFixtureArgumentsAndFiles` checks invalid arguments/environment, exclusive output and secret-free errors. `TestCatalogAndImages` checks unique keys/IDs/SKUs, stable data/asset digest, parseable passive SVGs, working image responses and the intentional 404.

The full native race/integration suite passed on 2026-10-21 (PostgreSQL integration package **63.079s**), including earlier checkout/recovery/process-crash tests. The focused fixture race test subsequently passed (**4.321s**) with an added pristine-state assertion. Native static/generation/unit gates, integration-tagged vet, fixture build, PowerShell AST, Git Bash syntax and a PowerShell-create/Bash-check/remove round trip passed. A PowerShell `fixture-run` startup smoke check reached schema readiness and read all 34 active fixture products through the actual API on a temporary IPv4 loopback port using a direct no-proxy client; only its own processes/database/bundle were then removed. This is not browser/cookie proof. One final-check sqlc invocation crashed in the installed parser; the unchanged command passed on rerun. Raw logs are ignored `.cache/milestone6-fixtures-integration-race.log`, `.cache/milestone6-fixtures-check*.log` and `.cache/milestone6-fixture-run.*.log`. Fixtures reuse the existing schema/role/grant policy; no new domain table, runtime dependency, infrastructure service or tooling container was added. Milestone 6 completion prepares M7; it does not claim frontend application/browser acceptance, production deployment or native Linux/macOS execution.

## Milestone 10 checkout fault verification

Task 5 reuses the integration-only private API/IPC and existing simulator injection. Checkout interruption returns a real pending 202; an ownership-checked, initially deferred constraint trigger raises at COMMIT in the disposable fixture to prove complete T1 rollback. Restore removes that trigger/function before same-key retry. These controls exist only in Go test files, require the owned fixture marker/bundle and add no production HTTP route, flag or migration. Reply interception tests malformed/503/lost results after real commits; it does not reproduce server COMMIT-acknowledgement loss. Routine tests use the existing private SMTP peer and send no external email. See [submission evidence and limits](TEST_PLAN.md#milestone-10-submission-progress).
