# API integration

How the browser calls the API. The contract is [OpenAPI 1.7.0](../api/openapi.yaml). A unit test (`frontend/src/shared/api/contracts.test.ts`) parses both that file and the [operation inventory](#operation-inventory) below. It fails if a client method, a row here and the contract disagree.

## Design choices

| Choice | Why | Trade-off accepted |
|---|---|---|
| **No automatic retries, redirects, caching or refresh in the transport** | Each retry decision is made where the consequences are known (see the retry policy) | Every feature has to decide what a failure means |
| **Errors are typed** (`ApiRequestError`: HTTP, network, protocol, cancelled) and keep only the safe `{code, message}` and `Retry-After` | The UI explains the real situation; a lost connection is never shown as a rejection | A larger error-handling surface |
| **Credentials per call type, never "include everything"** | Public calls send no cookies; guest routes never send a bearer token; cookie writes always send Origin and the CSRF header | A credentials table to maintain |
| **Every request takes an `AbortSignal`**; navigation and unmount abort, and late results are ignored | No stale response can overwrite newer state | Cancellation has to be handled everywhere |
| **Totals in the browser are estimates; a missing price is never treated as zero** | The server's checkout total is the only authority | Unpriced lines block the subtotal |

## Credentials per call type

| Call type | Cookies | Bearer | Origin + `X-CSRF-Protection: 1` |
|---|---|---|---|
| Public catalog reads | omit | no | no |
| Register, password reset | omit | no | yes |
| Sign in, refresh, sign out | include (refresh cookie) | no | yes |
| Account reads and writes | omit | yes | no |
| Authenticated security POSTs | include (so the server can clear the cookie) | yes | yes |
| Checkout | omit | yes | no; adds `Idempotency-Key` |
| Guest routes | include (guest cookies) | **never** | yes on writes |
| Cart choice | include | yes | yes |

## Retry policy

| Operation | After a definitive 401 | After a network error, 5xx or timeout |
|---|---|---|
| Reads, and a name-only profile edit | Refresh once, replay once for the same identity | Show an explicit Retry; no loop |
| Every other write | **No replay** | **No replay.** Mark the outcome uncertain and block further edits until an explicit successful reread |

A failed or lost write is **never** treated as a rollback. `Retry-After` is honoured.

## Timeouts and polling

| Request | Deadline |
|---|---|
| Catalog and product reads | 10 s |
| Cookie operations (including the lock wait), feature reads and writes | 20 s |
| Lock acquisition (checkout, cart) | 5 s |
| Guest prepare / checkout POST | 10 s / 30 s |

Cart enrichment fetches product details with at most 4 concurrent requests and a 10 s overall deadline. A pending order is polled only while its page is open and visible: one read every 3 s after the previous one finishes, for at most 60 s or 20 reads. Pending isn't failure, and a timeout isn't a rejection.

## Operation inventory

Every operation in the contract, with the client method that calls it, the screen that uses it, and its tests.

## Accounts and security

| Operation | Client method | Screen | Tests |
|---|---|---|---|
| `POST /auth/login` | [`login`](../../frontend/src/features/auth/AuthForm.tsx) | Sign in | [unit](../../frontend/src/features/auth/forms.test.tsx); [browser](../../frontend/tests/e2e/auth.spec.ts) |
| `POST /auth/logout` | [`logout`](../../frontend/src/features/auth/session.ts) | Sign out | [unit](../../frontend/src/features/auth/session.test.ts); [browser](../../frontend/tests/e2e/session.spec.ts) |
| `POST /auth/password-resets` | [`requestPasswordReset`](../../frontend/src/features/auth/PasswordRecovery.tsx) | `/forgot-password` | [unit](../../frontend/src/features/auth/recovery.test.tsx); [browser](../../frontend/tests/e2e/password-recovery.spec.ts) |
| `POST /auth/password-resets/confirm` | [`confirmPasswordReset`](../../frontend/src/features/auth/session.ts) | `/reset-password` | [unit](../../frontend/src/features/auth/recovery.test.tsx); [browser](../../frontend/tests/e2e/password-recovery.spec.ts) |
| `POST /auth/refresh` | [`refresh`](../../frontend/src/features/auth/session.ts) | Session restore and renewal | [unit](../../frontend/src/features/auth/session.test.ts); [browser](../../frontend/tests/e2e/session.spec.ts) |
| `POST /auth/register` | [`register`](../../frontend/src/features/auth/AuthForm.tsx) | Sign up | [unit](../../frontend/src/features/auth/forms.test.tsx); [browser](../../frontend/tests/e2e/auth.spec.ts) |
| `GET /users/me` | [`getMe`](../../frontend/src/features/auth/session.ts) | Session identity | [unit](../../frontend/src/features/auth/SessionBoundary.test.tsx); [browser](../../frontend/tests/e2e/authorization.spec.ts) |
| `PATCH /users/me` | [`updateMe`](../../frontend/src/features/auth/session.ts) | Profile form | [unit](../../frontend/src/features/account/account.test.tsx); [browser](../../frontend/tests/e2e/account.spec.ts) |
| `GET /users/me/addresses` | [`listAddresses`](../../frontend/src/features/account/AddressesPage.tsx) | Address book, checkout address picker | [unit](../../frontend/src/features/account/addresses.test.tsx); [browser](../../frontend/tests/e2e/addresses.spec.ts) |
| `POST /users/me/addresses` | [`createAddress`](../../frontend/src/features/account/AddressesPage.tsx) | Add address | [unit](../../frontend/src/features/account/addresses.test.tsx); [browser](../../frontend/tests/e2e/addresses.spec.ts) |
| `PATCH /users/me/addresses/{id}` | [`updateAddress`](../../frontend/src/features/account/AddressesPage.tsx) | Edit address | [unit](../../frontend/src/features/account/addresses.test.tsx); [browser](../../frontend/tests/e2e/addresses.spec.ts) |
| `DELETE /users/me/addresses/{id}` | [`deleteAddress`](../../frontend/src/features/account/AddressesPage.tsx) | Delete address | [unit](../../frontend/src/features/account/addresses.test.tsx); [browser](../../frontend/tests/e2e/addresses.spec.ts) |
| `POST /users/me/email-change` | [`requestEmailChange`](../../frontend/src/features/auth/session.ts) | Change email (request) | [unit](../../frontend/src/features/account/email-change.test.tsx); [browser](../../frontend/tests/e2e/email-change.spec.ts) |
| `POST /users/me/email-change/cancel` | [`cancelEmailChange`](../../frontend/src/features/auth/session.ts) | Cancel pending email change | [unit](../../frontend/src/features/account/email-change.test.tsx); [browser](../../frontend/tests/e2e/email-change.spec.ts) |
| `POST /users/me/email-change/confirm` | [`confirmEmailChange`](../../frontend/src/features/auth/session.ts) | `/confirm-email-change` | [unit](../../frontend/src/features/account/email-change.test.tsx); [browser](../../frontend/tests/e2e/email-change.spec.ts) |
| `POST /users/me/email-verification` | [`requestVerification`](../../frontend/src/features/auth/session.ts) | Verify email (request) | [unit](../../frontend/src/features/account/verification.test.tsx); [browser](../../frontend/tests/e2e/email-verification.spec.ts) |
| `POST /users/me/email-verification/confirm` | [`confirmVerification`](../../frontend/src/features/auth/session.ts) | `/verify-email` | [unit](../../frontend/src/features/account/verification.test.tsx); [browser](../../frontend/tests/e2e/email-verification.spec.ts) |
| `POST /users/me/password` | [`changePassword`](../../frontend/src/features/auth/session.ts) | `/account/security` | [unit](../../frontend/src/features/account/security.test.tsx); [browser](../../frontend/tests/e2e/account-security.spec.ts) |
| `GET /users/me/security` | [`getSecurity`](../../frontend/src/features/account/useSecurityStatus.ts) | `/account/security` | [unit](../../frontend/src/features/account/security.test.tsx); [browser](../../frontend/tests/e2e/email-verification.spec.ts) |

## Catalog, cart and orders

| Operation | Client method | Screen | Tests |
|---|---|---|---|
| `GET /cart` | [`getCart`](../../frontend/src/features/cart/CartController.ts) | Cart, header badge, checkout review | [unit](../../frontend/src/features/cart/cart.test.tsx); [browser](../../frontend/tests/e2e/cart.spec.ts) |
| `POST /cart/items` | [`addCartItem`](../../frontend/src/features/cart/CartController.ts) | Add to cart | [unit](../../frontend/src/features/cart/storefront.test.tsx); [browser](../../frontend/tests/e2e/storefront-cart.spec.ts) |
| `DELETE /cart/items` | [`clearCart`](../../frontend/src/features/cart/CartController.ts) | Clear cart | [unit](../../frontend/src/features/cart/cart.test.tsx); [browser](../../frontend/tests/e2e/cart.spec.ts) |
| `PATCH /cart/items/{id}` | [`replaceCartItem`](../../frontend/src/features/cart/CartController.ts) | Cart quantity | [unit](../../frontend/src/features/cart/cart.test.tsx); [browser](../../frontend/tests/e2e/cart.spec.ts) |
| `DELETE /cart/items/{id}` | [`removeCartItem`](../../frontend/src/features/cart/CartController.ts) | Remove line | [unit](../../frontend/src/features/cart/cart.test.tsx); [browser](../../frontend/tests/e2e/cart.spec.ts) |
| `POST /checkout` | [`checkout`](../../frontend/src/features/checkout/checkoutSubmission.ts) | Checkout submit and resume | [unit](../../frontend/src/features/checkout/checkoutSubmission.test.ts); [browser](../../frontend/tests/e2e/checkout-submission.spec.ts) |
| `GET /orders` | [`listOrders`](../../frontend/src/features/orders/OrdersPage.tsx) | Order history | [unit](../../frontend/src/features/orders/orders.test.tsx); [browser](../../frontend/tests/e2e/orders.spec.ts) |
| `GET /orders/{id}` | [`getOrder`](../../frontend/src/features/orders/orderRead.ts) | Order detail and status polling | [unit](../../frontend/src/features/orders/orders.test.tsx); [browser](../../frontend/tests/e2e/orders.spec.ts) |
| `POST /orders/{id}/cancel` | [`cancelOrder`](../../frontend/src/features/orders/OrdersPage.tsx) | Cancel order | [unit](../../frontend/src/features/orders/orders.test.tsx); [browser](../../frontend/tests/e2e/orders.spec.ts) |
| `GET /orders/{id}/payments` | [`getOrderPayments`](../../frontend/src/features/orders/orderRead.ts) | Payment panel | [unit](../../frontend/src/features/orders/orders.test.tsx); [browser](../../frontend/tests/e2e/orders.spec.ts) |
| `GET /products` | [`listProducts`](../../frontend/src/features/catalog/CatalogPage.tsx) | Catalog and search | [unit](../../frontend/src/features/catalog/catalog.test.tsx); [browser](../../frontend/tests/e2e/catalog.spec.ts) |
| `GET /products/{id}` | [`getProduct`](../../frontend/src/features/catalog/ProductDetailPage.tsx) | Product detail, cart enrichment | [unit](../../frontend/src/features/catalog/product-detail.test.tsx); [browser](../../frontend/tests/e2e/product-detail.spec.ts) |

## Administration

| Operation | Client method | Screen | Tests |
|---|---|---|---|
| `GET /admin/products` | [`listAdminProducts`](../../frontend/src/features/admin/AdminProductsPage.tsx) | Admin product list and search | [unit](../../frontend/src/features/admin/AdminProductsPage.test.tsx); [browser](../../frontend/tests/e2e/admin-products.spec.ts) |
| `POST /admin/products` | [`createProduct`](../../frontend/src/features/admin/CreateProductPage.tsx) | Create product | [unit](../../frontend/src/features/admin/CreateProductPage.test.tsx); [browser](../../frontend/tests/e2e/admin-create.spec.ts) |
| `GET /admin/products/{id}` | [`getAdminProduct`](../../frontend/src/features/admin/AdminProductPage.tsx) | Admin product detail | [unit](../../frontend/src/features/admin/AdminProductPage.test.tsx); [browser](../../frontend/tests/e2e/admin-details.spec.ts) |
| `PATCH /admin/products/{id}` | [`updateProduct`](../../frontend/src/features/admin/EditProductPage.tsx) | Edit or reactivate product | [unit](../../frontend/src/features/admin/EditProductPage.test.tsx); [browser](../../frontend/tests/e2e/admin-edit.spec.ts) |
| `DELETE /admin/products/{id}` | [`retireProduct`](../../frontend/src/features/admin/EditProductPage.tsx) | Retire product | [unit](../../frontend/src/features/admin/EditProductPage.test.tsx); [browser](../../frontend/tests/e2e/admin-availability.spec.ts) |
| `GET /admin/products/{id}/inventory` | [`getAdminInventory`](../../frontend/src/features/admin/AdminInventoryPage.tsx) | Admin stock | [unit](../../frontend/src/features/admin/AdminInventoryPage.test.tsx); [browser](../../frontend/tests/e2e/admin-details.spec.ts) |
| `PATCH /admin/products/{id}/inventory` | [`adjustInventory`](../../frontend/src/features/admin/AdminInventoryPage.tsx) | Adjust stock | [unit](../../frontend/src/features/admin/AdminInventoryPage.test.tsx); [browser](../../frontend/tests/e2e/admin-stock.spec.ts) |

## Guest session and cart

| Operation | Client method | Screen | Tests |
|---|---|---|---|
| `GET /guest/cart` | [`getGuestCart`](../../frontend/src/shared/api/guest.ts) | Guest cart | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `GET /guest/cart-choice` | [`getGuestCartChoice`](../../frontend/src/shared/api/guest.ts) | Sign-in cart choice (read) | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `POST /guest/cart-choice` | [`chooseGuestCart`](../../frontend/src/shared/api/guest.ts) | Sign-in cart choice (keep or replace) | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `POST /guest/cart/items` | [`addGuestCartItem`](../../frontend/src/shared/api/guest.ts) | Guest add to cart | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `DELETE /guest/cart/items` | [`clearGuestCart`](../../frontend/src/shared/api/guest.ts) | Guest clear cart | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `PATCH /guest/cart/items/{id}` | [`replaceGuestCartItem`](../../frontend/src/shared/api/guest.ts) | Guest cart quantity | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `DELETE /guest/cart/items/{id}` | [`removeGuestCartItem`](../../frontend/src/shared/api/guest.ts) | Guest remove line | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `GET /guest/session` | [`getGuestSession`](../../frontend/src/shared/api/guest.ts) | Guest session check | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `POST /guest/session` | [`createGuestSession`](../../frontend/src/shared/api/guest.ts) | Guest bootstrap on first cart action | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `DELETE /guest/session` | [`endGuestSession`](../../frontend/src/shared/api/guest.ts) | Clear guest session | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |
| `POST /guest/session/rotate` | [`rotateGuestSession`](../../frontend/src/shared/api/guest.ts) | Guest identity change | [Go](../../backend/internal/platform/integration/guest_test.go), [browser](../../frontend/tests/e2e/guest-contract.spec.ts) |

## Guest checkout and recovery

| Operation | Client method | Screen | Tests |
|---|---|---|---|
| `POST /guest/checkout` | [`checkoutGuest`](../../frontend/src/shared/api/guest.ts) | Guest checkout: place (owner or intent grant) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `POST /guest/checkout-intents` | [`prepareGuestCheckout`](../../frontend/src/shared/api/guest.ts) | Guest checkout: prepare (full cookie) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `GET /guest/checkout-intents/{id}` | [`getGuestCheckoutIntent`](../../frontend/src/shared/api/guest.ts) | Guest checkout: read intent (owner or intent grant) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `POST /guest/checkout-intents/{id}/retire` | [`retireGuestCheckoutIntent`](../../frontend/src/shared/api/guest.ts) | Guest checkout: retire (owner or intent grant) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `GET /guest/orders` | [`listGuestOrders`](../../frontend/src/shared/api/guest.ts) | Guest order history (full cookie) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `GET /guest/orders/{id}` | [`getGuestOrder`](../../frontend/src/shared/api/guest.ts) | Guest order detail (owner or grant) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `POST /guest/orders/{id}/cancel` | [`cancelGuestOrder`](../../frontend/src/shared/api/guest.ts) | Guest cancel (owner or grant) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `GET /guest/orders/{id}/payments` | [`getGuestOrderPayments`](../../frontend/src/shared/api/guest.ts) | Guest payment panel (owner or grant) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `GET /guest/recovery-access` | [`getGuestRecoveryAccess`](../../frontend/src/shared/api/guest.ts) | Check recovery grant | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `DELETE /guest/recovery-access` | [`endGuestRecoveryAccess`](../../frontend/src/shared/api/guest.ts) | End recovery grant | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `POST /guest/recovery-confirmations` | [`confirmGuestRecovery`](../../frontend/src/shared/api/guest.ts) | `/guest/recover`: redeem proof (public) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |
| `POST /guest/recovery-requests` | [`requestGuestRecovery`](../../frontend/src/shared/api/guest.ts) | `/guest/recover`: request (public) | [Go](../../backend/internal/platform/integration/guest_checkout_test.go), [browser](../../frontend/tests/e2e/milestone13-checkout.spec.ts) |

## Operational routes

| Operation | Caller | Tests |
|---|---|---|
| `GET /health/live` | ALB target health | [TestHealthAndErrors](../../backend/internal/platform/httpserver/server_test.go) |
| `GET /health/ready` | Deployment checks | [TestReadyAndPanic](../../backend/internal/platform/httpserver/server_test.go), [TestFoundation](../../backend/internal/platform/integration/foundation_test.go) |
| `GET /metrics` | Admin bearer only | [TestAuthentication](../../backend/internal/platform/integration/auth_test.go) |
