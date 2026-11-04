# Commerce Lab frontend

The Task 5 guest checkout and recovery backend is implemented in API 1.7.0 with readiness 13. Task 5 acceptance includes confirmed mailbox delivery. Task 6 owns guest transport and lifecycle. The isolated mint preview uses synthetic data. [Project status](../docs/PROJECT_STATUS.md) · [Design preview](design-preview/README.md)

Milestone 11 is complete, including functional acceptance and the visual-polish
handoff. [Final outcomes/limits](../docs/frontend/TEST_PLAN.md#milestone-11-functional-acceptance-and-visual-polish-handoff)
map all 30 requirements and 38 business-operation owners/three operator exceptions.
Task 11's two UI-only
journeys at **360/1280px** connect administrator product creation/stock to customer
purchase, source edits/retirement and immutable owned order history. They also
verify explicit description clearing and persistence; other accounts cannot read
the order or enter administrator screens.
M11’s **1,333** unit/component checks, build/type checking, native static/build/module
checks, the post-mitigation Go race/integration suite (**11 tested packages,
422 test/subtest passes**) and the full **306-test/38-spec** browser gate pass.
[Execution evidence and limits](../docs/frontend/TEST_PLAN.md#milestone-11-complete-application-acceptance-execution)
records fixture fixes, earlier failures, expected skips and cleanup. Verification
required a WSL/Docker restart and temporary Ubuntu time-sync stop; the service
remains inactive until manually started or Ubuntu restarts. No boot configuration
or production code changed. The existing default Vite size warning remains.
Task 12 changes documentation only and records the [M12 entry handoff](../docs/frontend/UI_DESIGN.md#milestone-12-entry-handoff).
Milestone 12 is complete: foundations, shell and customer/administrator pages
follow the selected dark direction. **1,334/44** unit/component checks/suites,
type/build, native static/generation/vet/unit/goose checks and the final full
**326 browser checks/44 specs** pass with zero retries: 323 native Go/PostgreSQL
journeys and three mocked public-shell checks. [Visual acceptance and handoff](../docs/frontend/VISUAL_ACCEPTANCE.md)
records 94 inspected synthetic frames, five-width native coverage, the initial
shell failure/checkout timeout, focused rechecks, stronger shell destination
readiness, stable post-restart clocks and cleanup. The temporary time-sync stop,
existing bundle warning and platform limits remain documented. Next: [Milestone 13 shopping revision](../docs/frontend/SHOPPING_EXPERIENCE.md),
including mint Tailwind/shadcn presentation, guest purchase and both existing simulation choices.
Milestone 14 owns packaging/deployment/HTTPS and release verification afterward.

M13 Task 2 is complete (2026-11-02): the installed Tailwind/Vite **4.3.3** and
shadcn CLI **4.23.0** are configured with project-owned Button/Input, existing
semantic tokens and `@/` aliases. Prefixed `tw:` utilities coexist with CSS Modules
without Preflight; Field inputs and search/signup/login buttons are migrated.
The [component guide](src/shared/ui/primitives/README.md) explains local CLI/MCP
usage and maintained adaptations. **1,340 tests/45 suites**, type/build, seven
focused and all **327 browser tests/44 specs** pass (693.266s, zero retries).
[Evidence and limits](../docs/frontend/TEST_PLAN.md#milestone-13--tailwindshadcn-foundation)
retain the corrected legacy-specificity regression, clock mitigation, cleanup
and existing bundle warning. Other M13 tasks, including finalized layouts,
guest ownership/checkout, admin search and current-cart-only presentation, remain pending;
both deterministic payment scenarios are retained.

Milestone 10 completes protected `/checkout` review, **Place simulated order**
and **Resume Original Checkout**. Placement saves the original key/body before one
send. Uncertain outcomes retain that request for explicit same-key recovery;
authoritative orders reach durable handoff before cart refresh and order GETs.
Seven verified pre-commit rejection codes require **Retire rejected checkout and
review again**, then fresh cart/address/simulation choices before another placement.
Retirement sends no checkout and generates no key. Generic validation/authentication,
malformed or unknown replies and idempotency conflicts preserve the original intent.
Exhausted cart versions block placement without resetting the version. Check Status
makes a bounded manual read; pending-only automatic observation is bounded below.

Protected `/orders` history and `/orders/:orderId` details show immutable
purchase/shipping snapshots, safe payment fields and eligible cancellation. Cancellation
requires confirmation, sends once and resolves uncertainty through same-order reads.
Pending/failed reads do not prove rollback; retry always requires explicit same-order
confirmation. History/detail navigation retains the checkout recovery locator.
Known-order checkout and details share bounded observation: ten-second
logical reads, three-second completion spacing, and at most sixty elapsed seconds or
twenty actual order/payment GETs, including auth replay/fallback. Terminal/failure,
inactivity and obsolete scopes stop/cancel it. Manual Check Status and foreground return
never restart the loop. Last snapshots and the recovery locator remain intact.
Milestone 10 and GAP-06 are complete: **882** unit/component checks, all **187**
Chromium tests with zero retries, build/type checking and the full native PostgreSQL
race/integration suite pass. [Acceptance evidence and limits](../docs/frontend/TEST_PLAN.md#milestone-10-acceptance)
map all seven requirements; [project status](../docs/PROJECT_STATUS.md) points to M11
administration/global hardening. M12 covers visual design/polish and post-style
regressions; final packaging/tagging remains M14.

Milestones 7–9 are complete: signup/login, coordinated sessions/server logout and
guarded `/account` and `/admin` (access landing) routes pass real-backend
acceptance. Registration offers a deliberate login; identity is confirmed before
private content appears. Milestone 8 adds public product cards, USD prices,
availability, image fallbacks and pagination at `/` and `/?offset=20`, plus
direct details at `/products/:productId`. Product names link to details and Back
to products preserves a validated search/page. The header searches active product
names/SKUs through the server; `/?q=lamp&offset=20` is a filtered page. Catalog
acceptance passes on Windows/Chromium. Current verification and limits are recorded
below. Milestone 9 adds: `/account` now edits first/last names with
partial PATCH, server-returned form/header values, validation and explicit
reconciliation after uncertain saves. Email/account type stay read-only in the profile form; Reload
profile replaces unsaved edits. `/account/security` supports password changes and
explicit email verification. Password changes sign out every session; verification
preserves sessions and requires the requesting account/current password at the
minimal `/verify-email` page. Links are removed from the URL before auth starts,
kept only in memory and discarded on reload/navigation/identity changes; reopen the
newest email when needed. Security writes never renew/replay after 401 or uncertain outcomes.
TLS SMTP delivery, controlled mailbox receipt and the authenticated link round trip
are verified. See [private SMTP setup](../docs/backend/OPERATIONS.md#security-email-configuration-and-verification).
Verified email changes are implemented: request/replace/cancel in Account security,
then explicitly confirm both mailbox links at minimal `/confirm-email-change`.
The first proof keeps the old email; the second signs out every session and
requires deliberate login with the new email/existing password. Pending flags,
duplicate conflicts, partial delivery and uncertain outcomes have explicit feedback.
Forgotten-password recovery is implemented at `/forgot-password` and minimal `/reset-password` email links. Only active accounts with verified current email qualify. Valid admitted requests use the same five-second receipt; up to three 15-minute links remain valid. Explicit reset consumes the proof, changes the password and revokes all target sessions; sign in normally afterward. Public calls omit cookies/bearer credentials, and session rechecks preserve unrelated accounts. Reload/navigation/identity changes discard the private proof; reopen the original email. Uncertain outcomes never repeat the write. See [operator behavior/limits](../docs/backend/OPERATIONS.md#forgotten-password-recovery) and the [selected security design](../docs/backend/ACCOUNT_SECURITY_DESIGN.md).
Shipping addresses are implemented at `/account/addresses`, `/account/addresses/new` and `/account/addresses/:addressId/edit`, with Account navigation, owned cards/forms, US validation, optional-field clearing and explicit delete/cancel. Editors load the owned list and send changed fields only. Writes send once; uncertain outcomes require explicit saved-address review/reload before another change. Confirmed deletion reloads the list, and existing order snapshots remain unchanged. Cart operations/presentation and storefront/session integration are implemented in tasks 8–9; combined M9 acceptance is complete, with checkout/orders next in M10.

Product previews add one item; product details accept an explicit quantity 1–10000. Guests sign in and return to the product without an automatic purchase. The signed-in Cart link shows the server quantity sum and opens `/cart`; updating/unknown observations never appear as zero. Add quantity increments a product's existing quantity; Set quantity replaces an item quantity. Returned snapshots update the page/badge together; Remove and confirmed Clear cart reread after 204. Active zero-stock products may enter the cart, with no reservation or checkout availability guarantee.

One cart controller owns writes through same-identity SPA navigation. Identity/session changes clear its snapshot and unsent purchase drafts; public catalog/search stays mounted. Unconfirmed writes remain blocked through navigation, foreground checks and peer notices until explicit successful Reload cart/review. Reads can renew authentication once; writes never renew/replay after 401. Route/foreground/peer observations share overlapping reads and retain drafts/enrichment for unchanged versions. Explicit Reload cart replaces drafts and preserves otherwise-lost keyboard focus; changed server quantities reconcile their fields. Peer notices contain only an invalidation signal. No cart/draft enters browser storage/history; minimal email/recovery pages start no cart/product reads.

`/cart` and checkout review enrich products, using at most four concurrent public reads, one attempt per product per generation and a ten-second overall deadline (up to 100 products). Retry product details is explicit. Retired/missing products retain ID/quantity/image fallback and removal; failed/slow reads stay unpriced while quantity/removal actions remain usable. Subtotals appear only when every line is priced and checked arithmetic stays within the backend's supported bound. Reload replaces quantity drafts. Prices/availability remain estimates until checkout in M10. See [cart presentation evidence](../docs/frontend/TEST_PLAN.md#milestone-9-cart-progress) and [storefront integration evidence/limits](../docs/frontend/TEST_PLAN.md#milestone-9-storefront-integration-progress). Combined M9 and M10 checkout/order acceptance are verified.

Milestone 9 acceptance (2026-10-27): build/type checking, **491** unit/component checks across 22 suites, all **125** Chromium tests across 20 files, native static/generation/unit/integration-tagged vet/OpenAPI checks and the full PostgreSQL race/integration suite (**168.699s**) pass. [The acceptance matrix](../docs/frontend/TEST_PLAN.md#milestone-9-acceptance) covers combined account/security/address/cart persistence, ownership, real capacity/version bounds, request budgets and accessibility, with environment limits. All owned test resources are cleaned up; production backend/schema/API/dependencies remain unchanged. Current M10 progress/next task is in the project status linked above.

Earlier task 9 storefront verification (2026-10-27): build/type checking, **487** unit/component checks across 22 suites, all **120** Chromium tests across 19 files and the full PostgreSQL race/integration suite (**165.430s**) passed. Catalog/search checks distinguish product-title links from purchase links while retaining ordering/count/history/scroll/focus assertions. Current combined acceptance is above.

Earlier task 8 cart verification (2026-10-27): build/type checking, **470** unit/component checks across 21 suites, the full **111** Chromium tests across 18 files and all native static/generation/unit/integration-tagged vet/OpenAPI gates pass. The full PostgreSQL race/integration suite passes (**165.281s**). After that full browser run, local cart accessibility/layout adjustments passed the full frontend unit/build gates and eight focused cart journeys. This dated evidence retains its original scope; current integration verification is above.

See the [frontend plan](../docs/frontend/IMPLEMENTATION_SEQUENCE.md).

Use the locally installed Node **24.20.0** and npm **11.19.0**. Run from this
directory (use `npm.cmd` in PowerShell if script policy blocks `npm`):

```sh
npm ci --strict-peer-deps
npm run dev
```

Vite uses `http://localhost:5173` and fails if the port is occupied. The home page
loads the real public catalog without requiring login. An unavailable API shows
explicit catalog/session failure notices with deliberate retry actions.
Authentication uses the local Go API at `http://localhost:8080/api/v1`
with direct CORS and matching browser hostnames; no proxy is configured. Run the
backend using the root [setup instructions](../README.md#first-start).

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e:list
```

The build includes type checking. Vitest runs component/unit tests under `src/`
using jsdom (Node for controller/contract checks); Playwright discovers browser
tests under `tests/e2e/`. Configurations
and tests are also type checked. Missing tests fail instead of silently passing.
There is no additional linter/formatter dependency; `.editorconfig` owns whitespace.

## Testing commands

Harness maintenance is verified by **1,184** unit/component checks and the full
**226** browser tests with zero retries. The full browser run used three Go builds
for 223 fresh backends. [Timing/isolation evidence](../docs/frontend/TEST_PLAN.md#harness-performance-and-isolation-progress)
records the focused before/after samples, cleanup and limits. That dated evidence
predates the final M11 gates above; the current next step is Milestone 13; release is Milestone 14.

Run targeted unit files or `npm run test:watch` while editing. At task completion,
run all unit/component tests and the type/build gates, plus the affected browser
groups and new cases. The [verification policy](../docs/frontend/TEST_PLAN.md#verification-levels)
defines when a full browser run is required; focused runs are always reported as focused.

| Command | Browser coverage |
|---|---|
| `npm run test:e2e:admin` | All seven administrator operations plus consolidated route/API/session/current-role authorization |
| `npm run test:e2e:auth` | Authentication/session/authorization and account security/email/recovery |
| `npm run test:e2e:checkout` | Checkout, recovery, orders/observation and M10 acceptance |
| `npm run test:e2e:storefront` | Public/customer journeys, M9 acceptance and cross-application interaction/acceptance checks |
| `npm run test:e2e:harness` | Binary reuse and state isolation |
| `npm run test:e2e:smoke` | Public shell/navigation without a database |
| `npm run test:e2e:failed` | Failures from the most recent browser invocation |
| `npm run test:e2e` | Every discovered browser test |

Append `-- --list` to a group for discovery or `-- --grep "title"` to narrow a
diagnostic run. The last-failed selection is overwritten by later invocations;
it is a diagnostic filter, not cached proof for unchanged tests. Full discovery
remains unrestricted, and a unit check requires every spec to belong to one main
group so new files cannot silently disappear from focused coverage.

Browser execution requires the pinned Chromium revision. In PowerShell, keep its
download within the workspace before installing and running it:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Resolve-Path ..) '.cache/playwright'
npm exec -- playwright install chromium --only-shell
npm run test:e2e -- --project=chromium
```

In Bash, use `export PLAYWRIGHT_BROWSERS_PATH="$(cd .. && pwd)/.cache/playwright"`
before the same npm commands. `--only-shell` installs the headless Chromium build
used by these tests. The browser runner starts its own Vite server and
refuses to reuse an existing server. Full browser runs require the existing local
root `.env`, healthy PostgreSQL, Go 1.25.1 and installed goose. Each API-backed test
creates a fresh version-1 fixture through the existing [fixture workflow](../docs/frontend/FIXTURES.md)
and starts its own API on `127.0.0.1:18080`. Native executables are prepared lazily
once per worker under a new `.cache/frontend-e2e/<id>` directory: the fixture CLI,
ordinary API and one integration executable shared by mail-API/auth-control modes.
Only immutable code is reused. Every test gets new database data, accounts, JWT
secret, API process, mailbox/rate-limit state and browser context. The browser calls
`http://localhost:18080/api/v1`; test Vite configuration overrides the public API
URL without changing environment files. Ports 5173/18080 must be free; the development
API on 8080 is independent. Keep one worker; the harness rejects multiple workers
because its API port is fixed. Restart the command after changing tested sources.

Each test stops its API and removes its marker-owned database/private bundle, even
when the test fails. Worker shutdown waits for builds, then removes only known
executables from its owned directory. A process/database cleanup failure preserves
the worker binaries; unexpected files also prevent deletion. Older output is never
swept automatically. Interrupted processes can require the fixture guide's explicit
cleanup procedure. Executables are never reused across invocations; Go's native
build cache remains in `.cache/go-build`.

`npm run test:e2e:smoke` runs public-shell/navigation checks without PostgreSQL,
stubbing catalog reads and missing-cookie refresh. Discovery never builds binaries,
creates databases or starts Vite. `npm run test:e2e:harness` explicitly verifies
ordinary/mail/control reuse and fresh private/domain/browser state.

Browser traces/screenshots/video are disabled and test output artifacts are not
retained. The privacy reporter prints test names, source locations, safe HTTP
statuses, cleanup IDs, elapsed time and allowlisted numeric harness timings,
omitting raw errors, DOM snapshots, request values and
worker console output. Use the normal commands with this reporter when testing
real credentials. `test:e2e:list` uses the built-in list reporter for discovery.

`npm run preview` serves a production build on `http://localhost:4173`; it is a
local inspection server. Only `../fixtures/public` is copied as static public
content. The catalog manifest and private fixture bundles are outside that tree.
`VITE_*` values are public browser configuration; never put credentials there.

Selected versions and rationale are in [tooling](../docs/frontend/TOOLING.md),
with the reference pins/scripts in [toolchain.json](../docs/frontend/toolchain.json).
`package-lock.json` records the installed dependency tree; retain it in source
control and use `npm ci` for subsequent installations. Generated dependencies,
builds and test reports are ignored.

## Application boundaries

- `src/app/` composes routes and the render-error boundary. `BrowserRouter` is
  mounted in `main.tsx`; component tests can supply `MemoryRouter`.
- `src/shared/ui/` contains the store/header and form layouts, page title/focus,
  labelled input/error-summary components, notices, USD formatting and explicit async states.
  Native forms keep submission/validation behavior; feature code owns requests.
- `src/shared/api/` owns typed customer/catalog/checkout/order contracts, runtime guards
  and native fetch transport. The OpenAPI inventory verifies 31 implemented business
  methods, with seven administration methods still owned by M11. Focused source/type
  checks supplement full OpenAPI validation.
- `src/features/orders/` owns private history/details, strict offset navigation,
  immutable snapshots, bounded observation/manual reads and explicit bodyless cancellation.
  Its shared observer enforces actual-resource/deadline/lifetime guards without writing
  recovery metadata or triggering payment recovery.
  Failed/pending cancellation reads preserve uncertainty; retry requires confirmation
  for the same order. Snapshots/warnings remain within the verified private page lifetime.
- `src/features/auth/` owns signup/login forms, validation, safe return paths and
  the in-memory session controller. Native form values are read at
  submission to support autofill. Passwords are preserved exactly for requests
  and cleared afterward; nonsecret fields survive failures. Duplicate submissions
  are blocked and 429 Retry-After pauses explicit resubmission (advisory wait capped
  at one day). A failed profile read retries only that read, never login.
- `src/features/catalog/` owns public product listing/details, cards/images, offset
  parsing and pagination. `src/shared/catalogQuery.ts` supplies one search/query
  policy for the API, form, navigation and auth returns. Page size is 20 with
  Previous/Next and no invented total count.
  Loads have a ten-second deadline; navigation/unmount aborts and ignores stale
  responses. Listing/detail pages share that read lifetime. Failures require explicit
  retry; missing/retired details have a distinct missing view. Busy/status semantics
  distinguish pending, empty and completed reads. Retry focuses the heading and
  honors integer Retry-After with a one-day advisory cap; expiry never starts a read.
  Failed images retain usable product values/links. The header search
  submits explicitly, resets offset and retains `q` through paging/history/detail
  returns. Empty input or Clear search restores browsing. Unsupported/malformed
  browsing values offer Reset browsing. Details require a UUID and no query
  parameters, read current server values and offer image/description fallbacks.
  Purchase controls arrive with Milestone 9.
  The shell retains at most 50 public history-key/scroll-position pairs in memory.
  POP restores after products render; new user input cancels the pending move.
  Unmount removes listeners; no private data or persistent storage is involved.
  Catalog links have a 44px minimum height, and skip navigation focuses main
  without changing history or issuing another catalog read.

The API base defaults to `http://localhost:8080/api/v1`. To override it, copy
`.env.example` to an ignored `.env.local` and set `VITE_API_BASE_URL` to an absolute
HTTPS API root (local HTTP is allowed), with no credentials/query/fragment. Keep
frontend/API browser hostnames consistent for cookies and configure the backend's
exact frontend Origin. This setting is public; no backend `.env` is loaded here.

Construct the client with `createApiClient()`. Its register/login/refresh/logout/
profile/listProducts/getProduct methods return validated wire DTOs and accept an optional `AbortSignal`.
Cookie operations include credentials and `X-CSRF-Protection`; profile reads take
an explicit in-memory bearer token. Public products omit cookies/bearer/CSRF and
load independently of session restoration. The browser supplies Origin. A 204 is bodyless.
The client never persists credentials, logs payloads, follows redirects, refreshes
automatically or retries requests. `ApiRequestError` distinguishes HTTP, network,
protocol and cancellation failures and preserves safe HTTP codes/messages and
integer Retry-After seconds. Only a definitive HTTP 401 is an authentication
rejection; a failed/cancelled mutation may already have reached the server.

`AuthProvider` owns a `SessionController`. Private feature components use
`usePrivateSession()` beneath `SessionBoundary`; its `request` supplies the current bearer token and cancellation
signal, coalesces refresh, and permits at most one replay after a definitive 401
for the same confirmed identity/role. Network/protocol/500/503 failures never replay
the operation. Each protected navigation confirms the current profile before
mounting content; a failed check hides it and offers explicit read retry. Customers
visiting `/admin` see an access-denied page, while the API independently enforces roles.
Identity revisions destroy the private subtree and its state; navigation/unmount
cancels requests, and retained callbacks cannot use another page/identity's credentials.
Keep future private feature caches/providers inside this boundary. Same-identity
renewal preserves local state. Public UI remains outside this lifetime.

Reload performs credentialed refresh and profile confirmation. Access-token deadlines
start before the auth request, are checked again on foreground/private requests,
and trigger coordinated renewal. Web Locks serialize login/refresh/logout across
same-origin tabs; BroadcastChannel carries only state notices, never credentials.
Use a modern secure-context browser (localhost qualifies) with both APIs; missing
coordination fails closed with guidance. No storage fallback is used.

Cookie operations have a 20-second deadline. An uncertain refresh hides identity
and offers explicit recovery; a lost committed rotation may require signing in
again because its replacement secret cannot be recovered. Header sign-out hides
private identity immediately, waits for pending rotations, and calls server logout
without a JWT. Failure offers explicit sign-out retry and blocks automatic restoration;
only a confirmed server response permits a success state. A disappeared peer has
bounded recovery rather than an indefinite spinner. Closing/reloading a tab loses
its memory; only confirmed server logout revokes the shared session cookie.
Return destinations allow home with valid q/offset parameters, UUID product
details, `/account` and `/admin`; product/private destinations accept no query/fragment payload. Expand the
allowlist only when other destination routes are implemented.

Verification of M7 (2026-10-24, Windows): type checking/production build, **134** unit/
component checks and **33** Chromium tests passed. Real Go/PostgreSQL checks cover
auth/session/route regressions plus negative Origin/CSRF/CORS, expired JWT renewal,
fixed/expired database sessions, inactive accounts, role demotion and privacy.
The native static/generation/unit and full PostgreSQL integration/race gates pass
(integration package 66.412s). Chromium headless shell
156.0.8078.4 (revision 1248) is workspace-cached. Native API/test processes and
fixture databases/bundles were cleaned up. The [acceptance mapping](../docs/frontend/TEST_PLAN.md#milestone-7-acceptance)
explains test-only expiry/account controls and limits. That M7 verification did
not change production code/contracts/dependency pins. Other OS/browser coverage and packaged HTTPS/SPA
verification remain with hardening/release.

Email-change acceptance (2026-10-27): production build/type checking, **367** unit/component checks across eighteen suites and all **89** Chromium tests across fifteen files pass. Native generation/static/unit checks, integration-tagged vet, full PostgreSQL race/integration (**100.150s**) and OpenAPI 1.4.0 validation pass. The complete backend race run passed separately from Chromium after intermittent existing settlement-test failures; original checkout code/timeouts are unchanged. Schema stays 11, with no new migration/dependency. Owned test resources are cleaned up. [Acceptance and limits](../docs/frontend/TEST_PLAN.md#milestone-9-email-change-progress) records both-mailbox proof, revocation, conflict and delivery coverage. Forgotten-password recovery is next.

Recovery acceptance (2026-10-27): production build/type checking, **387** unit/component checks across nineteen suites, all **96** Chromium tests across sixteen files, native static/generation/unit checks, integration-tagged vet, OpenAPI 1.5.0 validation and the full PostgreSQL race/integration suite (**164.198s**) pass. A full WSL restart restored stable clock samples after earlier timing regressions; no validation or timeout was relaxed. [Acceptance/environment evidence and limits](../docs/frontend/TEST_PLAN.md#milestone-9-password-recovery-progress) records the details. Schema stays 11; no migration/dependency is added. Test resources and the temporary diagnostic probe were cleaned up. Next: M9 task 7 shipping addresses.

Shipping-address acceptance (2026-10-27): build/type checking, **426** unit/component checks across twenty suites, all **103** Chromium tests across seventeen files, native static/generation/unit checks, integration-tagged vet, OpenAPI validation and the full PostgreSQL race/integration suite (**195.670s**) pass. [Address acceptance and limits](../docs/frontend/TEST_PLAN.md#milestone-9-shipping-address-progress) records ownership, snapshots, uncertainty, session privacy and cleanup. No backend contract, schema, dependency or tooling container is added. Next: M9 task 8 cart operations/presentation.

Email-verification acceptance (2026-10-25): production build/type checking, **340** unit/component checks across seventeen suites and all **81** Chromium tests across fourteen files pass. Native generation/static/unit, integration-tagged vet, full PostgreSQL race/integration (**97.276s**) and OpenAPI validation pass. Migration 11 is applied; actual TLS SMTP delivery, authenticated link consumption and human mailbox receipt are confirmed. Owned fixtures/processes/private bundles/executables were cleaned up. [Acceptance and limits](../docs/frontend/TEST_PLAN.md#milestone-9-email-verification-progress) records that earlier increment; task 5 completion is recorded above.

Password-change verification (2026-10-25): production build/type checking, **322**
unit/component checks across sixteen suites and all **74** Chromium tests across
thirteen files pass. Native static/generation/unit and full PostgreSQL integration/
race checks pass (**74.828s** integration package), plus OpenAPI validation and
integration-tagged vet. Migration 10 is applied to the local database; test resources
were cleaned up. See [password acceptance/limits](../docs/frontend/TEST_PLAN.md#milestone-9-password-change-progress).
This earlier task 3 run did not include SMTP; task 4 evidence above supersedes its notification limitation. No dependency or fixture-data version change was introduced.

Profile-increment verification (2026-10-25): type checking/production build, **298** checks
across fifteen unit/component suites and all **68** Chromium tests across twelve
files pass. Five profile journeys prove omitted-field preservation despite a
concurrent edit, canonical form/header values, reload, Unicode/null validation,
uncertain-save reconciliation, expired-JWT renewal and account-switch isolation.
Owned test processes/databases/private bundles/executable directories were removed.
See [profile evidence and limits](../docs/frontend/TEST_PLAN.md#milestone-9-profile-progress).
Backend/OpenAPI/schema, dependency pins and fixture data are unchanged; the full
backend integration/race suite was not rerun for this frontend-only increment.

M8 complete (2026-10-24): type checking/build, **266** unit/component checks across fourteen suites
and all **63** Chromium tests across eleven files pass. Final journeys join keyboard,
skip/focus, history/scroll, direct reload, long text/breakpoints and signed-in public
browsing/logout with feature/state/auth regressions. See
[catalog acceptance](../docs/frontend/TEST_PLAN.md#milestone-8-acceptance) for evidence,
cleanup and limits. Global UX/other-browser and packaged checks remain M11–M14.
Backend/schema, dependency pins and version-1 fixture data are unchanged.

Harness cleanup maintenance (2026-10-24): build/type checking, **186** unit/component
checks and all **39** Chromium tests pass. The full browser run leaves no compiled
executable directories or test-port listeners. [Cleanup verification](../docs/frontend/TEST_PLAN.md#harness-cleanup-verification)
records failure-path, ownership and artifact cleanup checks.
