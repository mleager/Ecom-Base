import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { StoreLayout } from '../shared/ui/StoreLayout';
import { PageHeading } from '../shared/ui/PageHeading';
import { AuthForm } from '../features/auth/AuthForm';
import { ForgotPasswordPage, ResetPasswordPage } from '../features/auth/PasswordRecovery';
import { SessionBoundary, AdminBoundary } from '../features/auth/SessionBoundary';
import { AccountPage } from '../features/account/AccountPage';
import { AddressBookPage, AddressEditorPage } from '../features/account/AddressesPage';
import { SecurityPage } from '../features/account/SecurityPage';
import { EmailVerificationPage } from '../features/account/EmailVerificationPage';
import { EmailChangePage } from '../features/account/EmailChangePage';
import { AdminPage } from '../features/auth/AdminPage';
import { AdminProductsPage } from '../features/admin/AdminProductsPage';
import { AdminProductPage } from '../features/admin/AdminProductPage';
import { CreateProductPage } from '../features/admin/CreateProductPage';
import { EditProductPage } from '../features/admin/EditProductPage';
import { CatalogPage } from '../features/catalog/CatalogPage';
import { ProductDetailPage } from '../features/catalog/ProductDetailPage';
import { CartPage } from '../features/cart/CartPage';
import { CartProvider } from '../features/cart/CartProvider';
import { RecoveryProvider } from '../features/checkout/RecoveryProvider';
import { GuestCheckoutPage } from '../features/checkout/GuestCheckoutPage';
import { GuestRecoveredCheckoutPage } from '../features/checkout/GuestRecoveredCheckoutPage';
import { GuestRecoveryPage } from '../features/orders/GuestRecoveryPage';
import { GuestOrdersPage, GuestOrderStatusPage } from '../features/orders/GuestOrderStatusPage';
import { useAuth } from '../features/auth/AuthProvider';
import { RecoveryPage } from '../features/checkout/RecoveryPage';
import { OrdersPage, OrderDetailPage } from '../features/orders/OrdersPage';

function CheckoutPage() {
  const { session } = useAuth();
  return session.user === null ? <GuestCheckoutPage /> : <RecoveryPage />;
}

function CommerceOrders({ detail = false }: { detail?: boolean }) {
  const { session } = useAuth();
  const { orderId } = useParams();
  const { search } = useLocation();
  if (session.user === null) return detail && orderId !== undefined
    ? <Navigate to={`/guest/orders/${encodeURIComponent(orderId)}${search}`} replace />
    : <GuestOrdersPage />;
  return detail ? <OrderDetailPage /> : <OrdersPage />;
}

function NotFoundPage() {
  return (
    <section className="surface">
      <PageHeading title="Page not found" />
      <p>We couldn’t find that page.</p>
      <Link to="/">Return home</Link>
    </section>
  );
}

export function AppRoutes() {
  return (
    <RecoveryProvider><CartProvider><Routes>
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset-password" element={<ResetPasswordPage />} />
      <Route path="verify-email" element={<EmailVerificationPage />} />
      <Route path="confirm-email-change" element={<EmailChangePage />} />
      <Route path="guest/recover" element={<GuestRecoveryPage />} />
      <Route path="guest/checkout/:intentId" element={<GuestRecoveredCheckoutPage />} />
      <Route path="guest/orders/:orderId" element={<GuestOrderStatusPage />} />
      <Route element={<StoreLayout />}>
        <Route index element={<CatalogPage />} />
        <Route path="products/:productId" element={<ProductDetailPage />} />
        <Route path="signup" element={<AuthForm key="signup" mode="signup" />} />
        <Route path="login" element={<AuthForm key="login" mode="login" />} />
        <Route path="cart" element={<CartPage />} />
        <Route element={<SessionBoundary allowGuest />}>
          <Route path="checkout" element={<CheckoutPage />} />
          <Route path="orders" element={<CommerceOrders />} />
          <Route path="orders/:orderId" element={<CommerceOrders detail />} />
        </Route>
        <Route path="guest/orders" element={<GuestOrdersPage />} />
        <Route element={<SessionBoundary />}>
          <Route path="account" element={<AccountPage />} />
          <Route path="account/addresses" element={<AddressBookPage />} />
          <Route path="account/addresses/new" element={<AddressEditorPage key="new" mode="create" />} />
          <Route path="account/addresses/:addressId/edit" element={<AddressEditorPage mode="edit" />} />
          <Route path="account/security" element={<SecurityPage />} />
          <Route element={<AdminBoundary />}>
            <Route path="admin" element={<AdminPage />} />
            <Route path="admin/products" element={<AdminProductsPage />} />
            <Route path="admin/products/new" element={<CreateProductPage />} />
            <Route path="admin/products/:productId" element={<AdminProductPage />} />
            <Route path="admin/products/:productId/edit" element={<EditProductPage />} />
            <Route path="admin/products/:productId/inventory" element={<AdminProductPage view="inventory" />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes></CartProvider></RecoveryProvider>
  );
}
