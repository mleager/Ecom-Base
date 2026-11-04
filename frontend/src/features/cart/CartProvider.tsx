import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { configuredApiBaseUrl } from '../../shared/api/config';
import { useAuth } from '../auth/AuthProvider';
import { CartController } from './CartController';
import type { CartSnapshot } from './CartController';
import { GuestCommerce } from './GuestCommerce';
import type { GuestSession } from '../../shared/api/guest';

const CartContext = createContext<CartController | null>(null);
const GuestContext = createContext<{ commerce: GuestCommerce; add: (productId: string, quantity: number) => Promise<boolean> } | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const { controller, session } = useAuth(); const { key, pathname } = useLocation();
  const storefront = !['/verify-email', '/confirm-email-change', '/reset-password', '/forgot-password', '/guest/recover'].includes(pathname)
    && !/^\/guest\/(checkout|orders)\/[^/]+$/.test(pathname);
  const foregroundReads = useRef(storefront); foregroundReads.current = storefront;
  const commerce = useMemo(() => new GuestCommerce(controller), [controller]);
  const shopping = useSyncExternalStore(commerce.subscribe, commerce.getSnapshot);
  const retained = useRef<{ name: string; scope: ReturnType<typeof makeScope> } | null>(null);
  function makeScope(kind: 'guest' | 'user', id: string, revision: number, guest?: GuestSession) {
    const peer = { channel: null as BroadcastChannel | null };
    const access = {
      kind,
      active: () => {
        const now = controller.getSnapshot();
        const state = commerce.getSnapshot();
        return now.revision === revision && (kind === 'user'
          ? now.user?.id === id && (now.status === 'authenticated' || now.status === 'refreshing')
          : now.status === 'anonymous' && state.guest?.guest_id === id && (state.mode === 'guest' || state.mode === 'checking'));
      },
      assertWrite: (version: number) => {
        commerce.assertCart(revision, kind, id);
        if (kind === 'user' && version < commerce.getSnapshot().accountVersion) throw new Error('Recheck the current account cart.');
      },
      ...(guest === undefined ? {} : {
        beforeGuestWrite: (signal: AbortSignal) => commerce.beforeGuestWrite(guest, signal),
        verifyGuest: (signal: AbortSignal) => commerce.verifyGuestCart(guest, signal),
      }),
      pageSignal: () => commerce.pageSignal(),
    };
    return { peer, cart: new CartController(controller, revision, id, () => peer.channel?.postMessage('changed'), access) };
  }
  function scopeFor(kind: 'guest' | 'user', id: string, revision: number, guest?: GuestSession) {
    const name = `${revision}:${kind}:${id}`;
    if (retained.current?.name === name) return retained.current.scope;
    const scope = makeScope(kind, id, revision, guest);
    retained.current = { name, scope };
    return scope;
  }
  const guest = session.status === 'anonymous' && (shopping.mode === 'guest' || shopping.mode === 'checking') ? shopping.guest : null;
  const scope = session.user !== null ? scopeFor('user', session.user.id, session.revision)
    : guest !== null ? scopeFor('guest', guest.guest_id, session.revision, guest) : null;
  const cart = scope?.cart ?? null;
  useEffect(() => { commerce.setEnabled(foregroundReads.current); commerce.start(); return () => commerce.stop(); }, [commerce]);
  useEffect(() => { commerce.setEnabled(storefront); }, [commerce, storefront]);
  useEffect(() => { commerce.navigate(); }, [commerce, key]);
  useEffect(() => {
    const foreground = () => { if (foregroundReads.current && document.visibilityState === 'visible') void commerce.refresh(); };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key.includes(':guest:') || event.key.startsWith('commerce-lab:guest-checkout-hint:')) foreground();
    };
    window.addEventListener('focus', foreground); window.addEventListener('storage', storage);
    return () => { window.removeEventListener('focus', foreground); window.removeEventListener('storage', storage); };
  }, [commerce]);
  useEffect(() => {
    if (scope === null) return;
    const { cart, peer } = scope;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        peer.channel = new BroadcastChannel(`commerce-lab:cart:${configuredApiBaseUrl()}`);
        peer.channel.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (data === 'changed') {
            cart.invalidate(foregroundReads.current);
            if (cart.ownerKind === 'user') void commerce.refresh();
          }
        };
      } catch { /* Foreground/route reads still refresh when peer notices are unavailable. */ }
    }
    cart.start(foregroundReads.current);
    const foreground = () => { if (foregroundReads.current && document.visibilityState === 'visible') cart.invalidate(); };
    window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground);
    return () => { cart.stop(); peer.channel?.close(); peer.channel = null; window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground); };
  }, [scope, commerce]);
  useEffect(() => { if (cart !== null && storefront) void cart.refresh(); }, [cart, key, storefront]);
  useEffect(() => {
    if (cart?.ownerKind === 'user' && (cart.getSnapshot().cart?.version ?? 0) < shopping.accountVersion) cart.invalidate();
  }, [cart, shopping.accountVersion]);
  const add = async (productId: string, quantity: number) => {
    if (cart !== null) return cart.change({ kind: 'add', productId, quantity });
    const created = await commerce.create();
    if (created === null) return false;
    const next = scopeFor('guest', created.guest_id, session.revision, created).cart;
    next.start(false);
    if (!await next.refresh()) return false;
    return next.change({ kind: 'add', productId, quantity });
  };
  return <GuestContext.Provider value={{ commerce, add }}><CartContext.Provider value={cart}>{children}</CartContext.Provider></GuestContext.Provider>;
}

const subscribeEmpty = () => () => { };
const emptySnapshot = () => null;

export function useGuestCommerce() {
  const context = useContext(GuestContext);
  const state = useSyncExternalStore(context?.commerce.subscribe ?? subscribeEmpty, context?.commerce.getSnapshot ?? emptySnapshot);
  return state === null || context === null ? null : { ...state, ...context };
}

export function useStoreCart() {
  const controller = useContext(CartContext);
  const shopping = useGuestCommerce();
  const state = useSyncExternalStore<CartSnapshot | null>(controller?.subscribe ?? subscribeEmpty, controller?.getSnapshot ?? emptySnapshot);
  return controller === null || state === null || controller.ownerKind === 'guest' && shopping?.mode !== 'guest' ? null : { ...state, controller,
    blocked: state.blocked || shopping?.mode !== (controller.ownerKind === 'guest' ? 'guest' : 'account')
      || controller.ownerKind === 'user' && (state.cart?.version ?? 0) < shopping.accountVersion };
}

