export interface PreviewProduct {
  id: string;
  name: string;
  sku: string;
  price: number;
  image: string;
  description: string;
  stock: number;
}

export type Identity = 'guest' | 'customer' | 'admin';
export type DataState = 'ready' | 'loading' | 'empty' | 'error' | 'long' | 'missing-image' | 'unknown-price' | 'pending-write' | 'uncertain-write';
export type RecoveryState = 'none' | 'unresolved' | 'rejected' | 'known-refresh-failed' | 'storage-error';
export type PaymentScenario = 'accept' | 'reject';
export type OrderState = 'confirmed' | 'payment_failed' | 'pending_payment' | 'cancelled';
export type Cart = Record<string, number>;
export interface Shipping {
  email: string;
  recipient: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  zip: string;
}
export interface DemoOrder {
  id: string;
  owner: Identity;
  items: { product: PreviewProduct; quantity: number }[];
  shipping: Shipping;
  status: OrderState;
  scenario: PaymentScenario;
}
export interface DemoAddress { id: string; label: string; shipping: Shipping }

export const products: PreviewProduct[] = [
  { id: 'lamp', name: 'Amber Desk Lamp', sku: 'LAMP-AMBER', price: 3499, image: 'lamp.svg', stock: 50,
    description: 'A balanced desk lamp with an adjustable shade for everyday reading.' },
  { id: 'backpack', name: 'Amber Canvas Backpack', sku: 'PACK-AMBER', price: 4999, image: 'backpack.svg', stock: 50,
    description: 'A practical canvas backpack for your daily essentials.' },
  { id: 'bottle', name: 'Amber Travel Bottle', sku: 'BOTTLE-AMBER', price: 2499, image: 'bottle.svg', stock: 0,
    description: 'A reusable bottle for everyday travel. This sample has no available stock; a cart is not a reservation.' },
  { id: 'mug', name: 'Amber Stoneware Mug', sku: 'MUG-AMBER', price: 1599, image: 'mug.svg', stock: 50,
    description: 'A comfortable stoneware mug for a slower start to the day.' },
];

export const sampleCart: Cart = { lamp: 2, mug: 1 };
export const sampleShipping: Shipping = {
  email: 'jordan@example.test', recipient: 'Jordan River', line1: '123 Market Street',
  line2: '', city: 'Portland', region: 'OR', zip: '97201',
};
export const emptyShipping: Shipping = { email: '', recipient: '', line1: '', line2: '', city: '', region: '', zip: '' };
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const count = (cart: Cart) => Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
export const total = (cart: Cart) => products.reduce((sum, product) => sum + product.price * (cart[product.id] ?? 0), 0);
export const imageUrl = (product: PreviewProduct) => '/fixtures/v1/' + product.image;
export const items = (cart: Cart) => products.filter(product => cart[product.id]).map(product => ({ product: { ...product }, quantity: cart[product.id]! }));
export const orderTotal = (order: DemoOrder) => order.items.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
export const statusLabels: Record<OrderState, string> = {
  confirmed: 'Order confirmed', payment_failed: 'Simulated payment rejected', pending_payment: 'Payment pending', cancelled: 'Order cancelled',
};
export const stateLabels: Record<DataState, string> = {
  ready: 'Ready', loading: 'Loading', empty: 'Empty', error: 'Read failure', long: 'Long content',
  'missing-image': 'Missing images', 'unknown-price': 'Unknown estimates', 'pending-write': 'Pending write', 'uncertain-write': 'Uncertain write',
};
export const recoveryLabels: Record<RecoveryState, string> = {
  none: 'No recovery issue', unresolved: 'Unresolved checkout', rejected: 'Verified pre-commit rejection',
  'known-refresh-failed': 'Known order / cart refresh failed', 'storage-error': 'Unreadable recovery metadata',
};
export const usRegions = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
