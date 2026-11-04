import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { StoreLayout } from '../shared/ui/StoreLayout';
import { AsyncState } from '../shared/ui/AsyncState';
import { PageHeading } from '../shared/ui/PageHeading';
import { SessionBoundary, AdminBoundary } from '../features/auth/SessionBoundary';
import { CatalogPage } from '../features/catalog/CatalogPage';
import { ProductDetailPage } from '../features/catalog/ProductDetailPage';
import { CartPage } from '../features/cart/CartPage';
import { CartProvider } from '../features/cart/CartProvider';
import { RecoveryProvider } from '../features/checkout/RecoveryProvider';
import { useAuth } from '../features/auth/AuthProvider';
import { AuthForm } from '../features/auth/AuthForm';
import { ForgotPasswordPage, ResetPasswordPage } from '../features/auth/PasswordRecovery';
import { EmailVerificationPage } from '../features/account/EmailVerificationPage';
import { EmailChangePage } from '../features/account/EmailChangePage';

const AccountPage = lazy(() => import('../features/account/AccountPage').then(({ AccountPage }) => ({ default: AccountPage })));
const AddressBookPage = lazy(() => import('../features/account/AddressesPage').then(({ AddressBookPage }) => ({ default: AddressBookPage })));
const AddressEditorPage = lazy(() => import('../features/account/AddressesPage').then(({ AddressEditorPage }) => ({ default: AddressEditorPage })));
const SecurityPage = lazy(() => import('../features/account/SecurityPage').then(({ SecurityPage }) => ({ default: SecurityPage })));
const AdminPage = lazy(() => import('../features/auth/AdminPage').then(({ AdminPage }) => ({ default: AdminPage })));
const AdminProductsPage = lazy(() => import('../features/admin/AdminProductsPage').then(({ AdminProductsPage }) => ({ default: AdminProductsPage })));
const AdminProductPage = lazy(() => import('../features/admin/AdminProductPage').then(({ AdminProductPage }) => ({ default: AdminProductPage })));
const CreateProductPage = lazy(() => import('../features/admin/CreateProductPage').then(({ CreateProductPage }) => ({ default: CreateProductPage })));
const EditProductPage = lazy(() => import('../features/admin/EditProductPage').then(({ EditProductPage }) => ({ default: EditProductPage })));
const GuestCheckoutPage = lazy(() => import('../features/checkout/GuestCheckoutPage').then(({ GuestCheckoutPage }) => ({ default: GuestCheckoutPage })));
const GuestRecoveredCheckoutPage = lazy(() => import('../features/checkout/GuestRecoveredCheckoutPage').then(({ GuestRecoveredCheckoutPage }) => ({ default: GuestRecoveredCheckoutPage })));
const GuestRecoveryPage = lazy(() => import('../features/orders/GuestRecoveryPage').then(({ GuestRecoveryPage }) => ({ default: GuestRecoveryPage })));
const GuestOrdersPage = lazy(() => import('../features/orders/GuestOrderStatusPage').then(({ GuestOrdersPage }) => ({ default: GuestOrdersPage })));
const GuestOrderStatusPage = lazy(() => import('../features/orders/GuestOrderStatusPage').then(({ GuestOrderStatusPage }) => ({ default: GuestOrderStatusPage })));
const RecoveryPage = lazy(() => import('../features/checkout/RecoveryPage').then(({ RecoveryPage }) => ({ default: RecoveryPage })));
const OrdersPage = lazy(() => import('../features/orders/OrdersPage').then(({ OrdersPage }) => ({ default: OrdersPage })));
const OrderDetailPage = lazy(() => import('../features/orders/OrdersPage').then(({ OrderDetailPage }) => ({ default: OrderDetailPage })));

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
    <RecoveryProvider><CartProvider>
      <Suspense fallback={<main className="content"><AsyncState kind="loading" message="Loading page…" /></main>}>
        <Routes>
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
        </Routes>
      </Suspense>
    </CartProvider></RecoveryProvider>
  );
}
