import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { Input } from '@/shared/ui/primitives/input';
import { Badge, Button, Modal } from './ui';
import { count, money, recoveryLabels, stateLabels } from './data';
import type { DataState, Identity, RecoveryState } from './data';
import { PageTitle, useWideScreen } from './layout';
import { SearchBar } from './SearchBar';
import { sampleCart, sampleShipping } from './data';
import { PreviewProvider, usePreview } from './store';
import { Catalog, CartPage, CheckoutPage, OrderPage, OrdersPage, ProductPage, CartContents, ProductPicture } from './ShoppingPages';
import { AccountPage, AddressesPage, AddressForm, AuthPage, ForgotPage, SecurityPage, TokenPage } from './AccountPages';
import { AdminHome, AdminList, AdminProduct, AdminForm, InventoryPage } from './AdminPages';

function PreviewControls() {
  const store = usePreview(); const navigate = useNavigate();
  return <details className="review-controls">
    <summary>Design review controls</summary>
    <div className="review-fields">
      <label>Preview identity<select aria-label="Preview identity" value={store.identity} onChange={event => store.setIdentity(event.target.value as Identity)}>
        <option value="guest">Guest</option><option value="customer">Customer</option><option value="admin">Administrator</option>
      </select></label>
      <label>Preview data state<select aria-label="Preview data state" value={store.mode} onChange={event => store.setMode(event.target.value as DataState)}>
        {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Preview checkout recovery<select aria-label="Preview checkout recovery" value={store.recovery} onChange={event => store.setRecovery(event.target.value as RecoveryState)}>
        {Object.entries(recoveryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <Button variant="secondary" onClick={store.populate}>Populate sample cart</Button>
      <Button variant="secondary" onClick={() => {
        const id = store.place(sampleCart, sampleShipping, 'accept', 'pending_payment'); navigate('/orders/' + id);
      }}>Show pending sample order</Button>
    </div>
    <p className="muted">These controls simulate presentation states. There is no authentication, API, payment, mail or persistent storage. Switching identity clears active forms and overlays. Refresh resets the preview.</p>
  </details>;
}

function Header() {
  const store = usePreview(); const navigate = useNavigate(); const location = useLocation(); const header = useRef<HTMLElement>(null);
  const wide = useWideScreen();
  const browsing = location.pathname === '/' || location.pathname.startsWith('/products/');
  const unknown = store.mode === 'pending-write' || store.mode === 'uncertain-write' || store.mode === 'loading';
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    const observer = new ResizeObserver(() => document.documentElement.style.setProperty('--header-height', String(element.getBoundingClientRect().height) + 'px'));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <header className="site-header" ref={header}>
    <div className="header-content">
      <Link to="/" className="brand"><span className="brand-mark" aria-hidden="true">c</span>Commerce Lab<span className="brand-dot">.</span></Link>
      <SearchBar context="catalog" query={location.pathname === '/' ? new URLSearchParams(location.search).get('q') ?? '' : ''}
        onSubmit={value => navigate('/?q=' + encodeURIComponent(value))} />
      <div className="header-actions">
        {browsing ? <Button variant="secondary" aria-label={unknown ? 'Cart, count unavailable' : 'Cart, ' + count(store.cart) + ' items'}
          onClick={event => wide ? (store.setRailDismissed(false), store.setRailOpen(true)) : store.setOverlay({ kind: 'cart', trigger: event.currentTarget })}>
          Cart <Badge>{unknown ? '?' : count(store.cart)}</Badge>
        </Button> : <Button variant="secondary" asChild><Link to="/cart">Cart <Badge>{unknown ? '?' : count(store.cart)}</Badge></Link></Button>}
        <Button className="mobile-menu-trigger" variant="secondary" onClick={event => store.setOverlay({ kind: 'navigation', trigger: event.currentTarget })}>Menu</Button>
      </div>
      <nav className="desktop-navigation" aria-label="Main navigation">
        <NavLink to="/" end>Home</NavLink>
        {store.identity === 'guest' ? <><NavLink to="/login">Sign in</NavLink><NavLink to="/signup">Create an account</NavLink></>
          : <><NavLink to="/account">Your account</NavLink><NavLink to="/orders">Your orders</NavLink>
            {store.identity === 'admin' && <NavLink to="/admin">Administration</NavLink>}
            <Button variant="ghost" onClick={() => { store.setIdentity('guest'); navigate('/'); }}>Sign out</Button>
            <span className="identity-copy">Signed in as {store.mode === 'long' ? 'Jordan '.repeat(16) : store.identity === 'admin' ? 'Alex' : 'Jordan'}</span></>}
      </nav>
    </div>
  </header>;
}

function Overlay() {
  const store = usePreview(); const navigate = useNavigate(); const narrow = !useWideScreen('(min-width: 768px)');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    if (store.overlay?.kind === 'quantity') setQuantity(String(store.cart[store.overlay.product.id] ?? 1));
  }, [store.overlay, store.cart]);
  const overlay = store.overlay;
  if (overlay === null) return null;
  const close = () => store.setOverlay(null);
  switch (overlay.kind) {
    case 'quick':
      return <Modal open onOpenChange={open => { if (!open) close(); }} title={'Quick view: ' + overlay.product.name}
        description="Product details and a deliberate cart action." sheet={narrow} trigger={overlay.trigger}>
        <div className="quick-layout"><ProductPicture product={overlay.product} />
          <div className="quick-information"><p className="eyebrow">Everyday essentials</p><h2>{overlay.product.name}</h2>
            <p className="sku">{overlay.product.sku}</p><p className="price">{money(overlay.product.price)}</p>
            <Badge tone={overlay.product.stock ? 'success' : 'warning'}>{overlay.product.stock ? 'In stock' : 'Out of stock'}</Badge>
            <p>{overlay.product.description}</p>
            <Button disabled={store.blocked} onClick={() => store.add(overlay.product.id)}>Add to cart</Button>
            <p className="muted">Quantity changes are available in your full cart. Cart additions do not reserve stock.</p>
          </div></div>
      </Modal>;
    case 'cart':
      return <Modal open onOpenChange={open => { if (!open) close(); }} title="Your cart" description="Read-only quantities. Edit quantities in the full cart." sheet trigger={overlay.trigger}>
        <CartContents compact onNavigate={close} />
      </Modal>;
    case 'navigation':
      return <Modal open onOpenChange={open => { if (!open) close(); }} title="Navigation" description="Commerce Lab pages." sheet trigger={overlay.trigger}>
        <nav className="mobile-navigation" aria-label="Mobile navigation">
          {[['/', 'Home'], ['/cart', 'Your cart'], ...(store.identity === 'guest' ? [['/login', 'Sign in'], ['/signup', 'Create an account']]
            : [['/account', 'Your account'], ['/orders', 'Your orders'], ...(store.identity === 'admin' ? [['/admin', 'Administration']] : [])])].map(([href, label]) =>
              <Button key={href} variant="secondary" onClick={() => { close(); navigate(href!); }}>{label}</Button>)}
          {store.identity !== 'guest' && <Button variant="secondary" onClick={() => { store.setIdentity('guest'); navigate('/'); }}>Sign out</Button>}
        </nav>
      </Modal>;
    case 'quantity':
      return <Modal open onOpenChange={open => { if (!open) close(); }} title="Choose quantity" description="Enter a whole quantity from 1 to 10,000." trigger={overlay.trigger}>
        <form onSubmit={event => {
          event.preventDefault(); const value = Number(quantity);
          if (!Number.isInteger(value) || value < 1 || value > 10000) { setError('Enter a whole quantity from 1 to 10,000.'); return; }
          store.replace(overlay.product.id, value); close();
        }}>
          <label htmlFor="custom-quantity">Quantity for {overlay.product.name}</label>
          <Input id="custom-quantity" type="number" min={1} max={10000} step={1} value={quantity} onChange={event => setQuantity(event.target.value)}
            aria-invalid={error ? true : undefined} aria-describedby={error ? 'quantity-error' : undefined} required />
          {error && <p id="quantity-error" role="alert" className="error-text">{error}</p>}
          <Button type="submit">Update quantity</Button>
        </form>
      </Modal>;
  }
}

function Shell() {
  const store = usePreview(); const location = useLocation(); const wide = useWideScreen();
  const browsing = location.pathname === '/' || location.pathname.startsWith('/products/');
  const minimal = ['/forgot-password', '/reset-password', '/verify-email', '/confirm-email-change'].includes(location.pathname);
  const rail = browsing && wide && count(store.cart) > 0 && store.railOpen && !store.railDismissed && store.mode !== 'loading';
  useEffect(() => { store.setOverlay(null); }, [location.pathname]);
  useEffect(() => {
    if (store.notice === '') return;
    const timer = window.setTimeout(() => store.notify(''), 3500); return () => window.clearTimeout(timer);
  }, [store.notice]);
  return <>
    <div className="design-disclosure"><strong>M13 design preview</strong> · Sample data only · No API calls, real accounts, charges or orders</div>
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
    <PreviewControls />
    {!minimal && <Header />}
    {minimal && <div className="minimal-brand"><Link to="/" className="brand">Commerce Lab<span className="brand-dot">.</span></Link></div>}
    <div className={'application-layout' + (browsing ? ' application-layout--browsing' : '')}>
      <main id="main-content" tabIndex={-1} key={store.identity}>
        <Routes>
          <Route path="/" element={<Catalog />} /><Route path="/products/:id" element={<ProductPage />} />
          <Route path="/cart" element={<CartPage />} /><Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/orders" element={<OrdersPage />} /><Route path="/orders/:id" element={<OrderPage />} />
          <Route path="/account" element={<AccountPage />} /><Route path="/account/security" element={<SecurityPage />} />
          <Route path="/account/addresses" element={<AddressesPage />} /><Route path="/account/addresses/new" element={<AddressForm />} />
          <Route path="/account/addresses/:id/edit" element={<AddressForm edit />} />
          <Route path="/login" element={<AuthPage key="login" />} /><Route path="/signup" element={<AuthPage key="signup" signup />} />
          <Route path="/forgot-password" element={<ForgotPage />} /><Route path="/confirm-email-change" element={<TokenPage emailChange />} />
          <Route path="/reset-password" element={<TokenPage />} /><Route path="/verify-email" element={<TokenPage verify />} />
          <Route path="/admin" element={<AdminHome />} /><Route path="/admin/products" element={<AdminList />} />
          <Route path="/admin/products/new" element={<AdminForm />} /><Route path="/admin/products/:id" element={<AdminProduct />} />
          <Route path="/admin/products/:id/edit" element={<AdminForm edit />} /><Route path="/admin/products/:id/inventory" element={<InventoryPage />} />
          <Route path="*" element={<><PageTitle title="Page not found" /><Button asChild><Link to="/">Return home</Link></Button></>} />
        </Routes>
      </main>
      {rail && <aside data-slot="sidebar" className="mini-cart" aria-label="Mini cart">
        <div className="row between"><h2>Your cart <span className="muted">({count(store.cart)})</span></h2>
          <Button variant="ghost" size="sm" aria-label="Close mini cart" onClick={() => { store.setRailDismissed(true); store.setRailOpen(false); }}>Close</Button></div>
        <CartContents compact />
      </aside>}
    </div>
    <footer className="page-footer"><span>Commerce Lab · Everyday essentials.</span><span>Design preview — local sample data resets on reload.</span></footer>
    {store.notice && <div className="preview-toast" role="status" aria-atomic="true">{store.notice}</div>}
    <Overlay />
  </>;
}

export function DesignPreview() { return <PreviewProvider><Shell /></PreviewProvider>; }
