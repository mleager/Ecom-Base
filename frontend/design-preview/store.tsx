import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import type { Cart, DataState, DemoAddress, DemoOrder, Identity, OrderState, PaymentScenario, PreviewProduct, RecoveryState, Shipping } from './data';
import { items, products, sampleCart, sampleShipping } from './data';

export type Overlay = { kind: 'quick' | 'quantity'; product: PreviewProduct; trigger: HTMLElement | null }
  | { kind: 'cart' | 'navigation'; trigger: HTMLElement | null } | null;
interface PreviewStore {
  identity: Identity;
  setIdentity: (identity: Identity) => void;
  cart: Cart;
  products: PreviewProduct[];
  mode: DataState;
  setMode: (mode: DataState) => void;
  recovery: RecoveryState;
  setRecovery: (recovery: RecoveryState) => void;
  overlay: Overlay;
  setOverlay: (overlay: Overlay) => void;
  railDismissed: boolean;
  setRailDismissed: (value: boolean) => void;
  railOpen: boolean;
  setRailOpen: (value: boolean) => void;
  notice: string;
  notify: (value: string) => void;
  add: (id: string) => void;
  replace: (id: string, quantity: number) => void;
  remove: (id: string) => void;
  clear: () => void;
  populate: () => void;
  orders: DemoOrder[];
  place: (cart: Cart, shipping: Shipping, scenario: PaymentScenario, status?: OrderState) => string;
  updateOrder: (id: string, status: OrderState) => void;
  blocked: boolean;
  addresses: DemoAddress[];
  saveAddress: (id: string | undefined, label: string, shipping: Shipping) => string;
  removeAddress: (id: string) => void;
}
const Context = createContext<PreviewStore | null>(null);

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [identity, identityState] = useState<Identity>('guest');
  const [carts, setCarts] = useState<Record<Identity, Cart>>({ guest: {}, customer: { ...sampleCart }, admin: {} });
  const [mode, modeState] = useState<DataState>('ready');
  const [recovery, setRecovery] = useState<RecoveryState>('none');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [railDismissed, setRailDismissed] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [notice, notify] = useState('');
  const [orders, setOrders] = useState<DemoOrder[]>([]);
  const [addressBooks, setAddressBooks] = useState<Record<Identity, DemoAddress[]>>({
    guest: [],
    customer: [{ id: 'home', label: 'Home', shipping: { ...sampleShipping } }],
    admin: [{ id: 'home', label: 'Studio', shipping: { ...sampleShipping, recipient: 'Alex Morgan' } }],
  });
  const cart = carts[identity];
  const blocked = mode === 'pending-write' || mode === 'uncertain-write' || mode === 'loading';
  function setCart(next: Cart) { setCarts(current => ({ ...current, [identity]: next })); }
  function setIdentity(next: Identity) {
    identityState(next); modeState('ready'); setRecovery('none'); setOverlay(null);
    setRailDismissed(false); setRailOpen(false); notify('');
  }
  function setMode(next: DataState) {
    modeState(next); notify('');
    if (next === 'empty') setCart({});
  }
  function add(id: string) {
    if (blocked) return;
    const current = cart[id] ?? 0;
    if (current >= 10000) { notify('The maximum quantity is 10,000. Review your cart.'); return; }
    setCart({ ...cart, [id]: current + 1 });
    if (!railDismissed) setRailOpen(true);
    notify('Added one item to your cart.');
  }
  function replace(id: string, quantity: number) {
    if (blocked || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return;
    setCart({ ...cart, [id]: quantity }); notify('Cart quantity updated.');
  }
  function remove(id: string) {
    if (blocked) return;
    const next = { ...cart }; delete next[id]; setCart(next); notify('Item removed from your cart.');
  }
  function clear() { if (!blocked) { setCart({}); notify('Your cart is empty.'); } }
  function populate() { modeState('ready'); setCart({ ...sampleCart }); setRailDismissed(false); setRailOpen(true); notify('Sample cart loaded for design review.'); }
  function place(snapshot: Cart, shipping: Shipping, scenario: PaymentScenario, status?: OrderState) {
    const id = 'DEMO-' + String(1043 + orders.length);
    const order: DemoOrder = {
      id, owner: identity, items: items(snapshot), shipping: { ...shipping }, scenario,
      status: status ?? (scenario === 'accept' ? 'confirmed' : 'payment_failed'),
    };
    setOrders(current => [...current, order]); setCart({}); setRecovery('none'); setOverlay(null); notify('');
    return id;
  }
  function updateOrder(id: string, status: OrderState) {
    setOrders(current => current.map(order => order.owner === identity && order.id === id ? { ...order, status } : order));
  }
  function saveAddress(existingId: string | undefined, label: string, shipping: Shipping) {
    const id = existingId ?? 'address-' + String(addressBooks[identity].length + 1);
    const next = { id, label, shipping: { ...shipping } };
    setAddressBooks(current => ({ ...current, [identity]: existingId
      ? current[identity].map(value => value.id === id ? next : value) : [...current[identity], next] }));
    return id;
  }
  function removeAddress(id: string) {
    setAddressBooks(current => ({ ...current, [identity]: current[identity].filter(value => value.id !== id) }));
  }
  const history = identity === 'customer' ? [{
    id: 'DEMO-1042', owner: 'customer' as const, items: items({ backpack: 1 }),
    shipping: { ...sampleShipping }, scenario: 'accept' as const, status: 'confirmed' as const,
  }] : [];
  return <Context.Provider value={{
    identity, setIdentity, cart, products, mode, setMode, recovery, setRecovery, overlay, setOverlay,
    railDismissed, setRailDismissed, railOpen, setRailOpen, notice, notify, add, replace, remove, clear, populate,
    orders: [...history, ...orders.filter(order => order.owner === identity)], place, updateOrder, blocked,
    addresses: addressBooks[identity], saveAddress, removeAddress,
  }}>{children}</Context.Provider>;
}

export function usePreview() {
  const value = useContext(Context);
  if (value === null) throw new Error('Preview state is unavailable.');
  return value;
}
