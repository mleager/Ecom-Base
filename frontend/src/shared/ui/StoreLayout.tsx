import { NavLink, Outlet, useLocation } from 'react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../../features/auth/AuthProvider';
import { SessionNotice } from '../../features/auth/SessionNotice';
import { SearchForm } from '../../features/catalog/SearchForm';
import { parseCatalogQuery } from '../catalogQuery';
import { ShoppingAccess, StoreCartNotice } from '../../features/cart/StoreCart';
import { CartControl } from '../../features/cart/MiniCart';
import { CheckoutRecoveryNotice } from '../../features/checkout/RecoveryPage';
import { Button } from './primitives/button';
import { Dialog, DialogContent, DialogTrigger } from './primitives/dialog';

export function SiteHeader() {
  const { user, session, controller } = useAuth();
  const location = useLocation();
  const query = location.pathname === '/' ? parseCatalogQuery(location.search)?.q ?? '' : '';
  const anonymous = session.status === 'anonymous';
  const [menuKey, setMenuKey] = useState<string | null>(null);
  useEffect(() => { setMenuKey(null); }, [location.key]);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const desktop = window.matchMedia('(min-width: 40rem)');
    const close = (event: MediaQueryListEvent) => { if (event.matches) setMenuKey(null); };
    desktop.addEventListener('change', close);
    return () => desktop.removeEventListener('change', close);
  }, []);
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty('--store-header-height', `${element.offsetHeight}px`));
    observer.observe(element);
    return () => { observer.disconnect(); root.style.removeProperty('--store-header-height'); };
  }, []);
  function navigation(mobile = false) {
    const link = (to: string, label: string) => <Button asChild variant="ghost" size="sm" className="store-nav-link">
      <NavLink to={to} end={to === '/'} onClick={mobile ? () => setMenuKey(null) : undefined}>{label}</NavLink>
    </Button>;
    return <nav aria-label="Main navigation" className={mobile
      ? 'tw:mt-4 tw:grid tw:justify-items-start tw:gap-2'
      : 'tw:col-span-full tw:row-start-3 tw:hidden tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-x-2 tw:gap-y-1 tw:sm:flex tw:md:row-start-2'}>
      {link('/', 'Home')}
      {anonymous ? <>{link('/login', 'Sign in')}{link('/signup', 'Create an account')}{link('/guest/orders', 'Guest orders')}</> : user !== null ? <>
        {link('/account', 'Your account')}{link('/orders', 'Your orders')}
        {user.role === 'admin' && link('/admin', 'Administration')}
        <Button variant="ghost" size="sm" onClick={() => { setMenuKey(null); void controller.logout().catch(() => {}); }}>Sign out</Button>
        <span className="tw:min-w-0 tw:wrap-anywhere tw:text-sm tw:text-muted-foreground tw:sm:ml-auto">Signed in as {user.first_name}</span>
      </> : <span role="status" className="tw:text-sm tw:text-muted-foreground">{session.status === 'logging-out' ? 'Signing out…' : session.status === 'restoring' ? 'Checking session…' : 'Session not confirmed'}</span>}
    </nav>;
  }
  return (
    <header ref={header} className="tw:sticky tw:top-0 tw:z-20 tw:border-x-0 tw:border-t-0 tw:border-b tw:border-solid tw:border-border tw:bg-card tw:shadow-sm">
      <div className="store-frame tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-x-3 tw:gap-y-2 tw:py-2.5 tw:md:grid-cols-[auto_minmax(0,1fr)_auto] tw:md:gap-x-8 tw:md:gap-y-3.5 tw:md:pt-5 tw:md:pb-2">
        <NavLink to="/" end className="store-brand tw:col-start-1 tw:row-start-1 tw:inline-flex tw:min-h-11 tw:min-w-0 tw:items-center tw:gap-2 tw:justify-self-start tw:font-bold tw:tracking-tight tw:md:text-xl tw:md:whitespace-nowrap">
          <span aria-hidden="true" className="tw:grid tw:size-7 tw:shrink-0 tw:place-items-center tw:rounded-md tw:bg-primary tw:text-primary-foreground tw:md:size-[30px] tw:md:text-2xl">c</span>
          <span>Commerce Lab<span aria-hidden="true" className="tw:text-primary">.</span></span>
        </NavLink>
        <div className="tw:col-span-full tw:row-start-2 tw:min-w-0 tw:md:col-start-2 tw:md:col-end-3 tw:md:row-start-1"><SearchForm key={location.key} query={query} /></div>
        <div className="tw:col-start-2 tw:row-start-1 tw:flex tw:items-center tw:justify-self-end tw:gap-1.5 tw:md:col-start-3">
          {(anonymous || user !== null) && <CartControl />}
          <Dialog open={menuKey === location.key} onOpenChange={(open) => setMenuKey(open ? location.key : null)}>
            <DialogTrigger asChild><Button variant="outline" size="sm" className="tw:sm:hidden">Menu</Button></DialogTrigger>
            <DialogContent title="Menu" description="Commerce Lab navigation" sheet>{navigation(true)}</DialogContent>
          </Dialog>
        </div>
        {navigation()}
      </div>
    </header>
  );
}

export function StoreLayout() {
  const catalogScroll = useRef(new Map<string, number>());
  return (
    <>
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById('main-content')?.focus();
      }}>Skip to content</a>
      <SiteHeader />
      <main id="main-content" className="content" tabIndex={-1}>
        <SessionNotice />
        <ShoppingAccess />
        <StoreCartNotice />
        <CheckoutRecoveryNotice />
        <Outlet context={{ catalogScroll: catalogScroll.current }} />
      </main>
    </>
  );
}
