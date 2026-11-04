# M13 React design preview screenshots

**Captured/reviewed:** 2026-11-02, native cached Chromium. Labelled synthetic identities/products/shipping/orders only; no API, authentication, storage, mail or real payment. These are Task 1 design artifacts, not production guest/transaction acceptance.

[Interactive React preview/run guide](../../../../frontend/design-preview/README.md) · [Design acceptance and limits](../../M13_DESIGN_ACCEPTANCE.md). The earlier plain-HTML prototype/images in the parent directory remain historical and are superseded by this mint/explicit-simulation design.

| Screen | Preview |
|---|---|
| Desktop catalog; Cart opens a Sheet | [Screenshot](catalog-1280.png) |
| Four-card catalog with independent viewport-edge mini-cart | [Screenshot](catalog-1920.png) |
| Large desktop catalog with unchanged card positions | [Screenshot](catalog-2560.png) |
| Phone catalog | [Screenshot](catalog-360.png) |
| Desktop Quick View Dialog | [Screenshot](quick-view-1280.png) |
| Phone Quick View Sheet | [Screenshot](quick-view-360.png) |
| Single-column desktop cart | [Screenshot](cart-1280.png) |
| Phone cart with quantity Select | [Screenshot](cart-360.png) |
| Guest checkout, desktop | [Screenshot](checkout-guest-1280.png) |
| Guest checkout, phone | [Screenshot](checkout-guest-360.png) |
| Signed-in checkout and address selection | [Screenshot](checkout-signed-1280.png) |
| Accepted simulated order | [Screenshot](order-accept-360.png) |
| Rejected simulated order | [Screenshot](order-reject-360.png) |
| Pending-order observation layout | [Screenshot](order-pending-1280.png) |
| Account/profile layout | [Screenshot](account-1280.png) |
| Account-security phone layout | [Screenshot](account-security-360.png) |
| Optional Home label placeholder | [Screenshot](account-addresses-new-360.png) |
| Administrator search/filter/table layout | [Screenshot](admin-products-1280.png) |
| Administrator product and inventory layout | [Screenshot](admin-products-lamp-1280.png) |
| Blocking contextual checkout recovery | [Screenshot](checkout-recovery-1280.png) |

Full five-width/state QA frames are regenerable using npm run design:check and remain in ignored .cache/milestone13/task1-frames/. Capture resets scroll and blurs focus, hides transient toasts for layout inspection, and uses viewport-only overlay screenshots. Keyboard/focus/live-feedback assertions run separately. No real customer data or credentials are captured.
