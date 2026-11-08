// @vitest-environment node
import { expect, test, vi } from 'vitest';
import type { Cart } from '../../shared/api/contracts';
import type { SessionController } from '../auth/session';
import { CartController } from './CartController';

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const product = uuid(2);
const cartAt = (version: number, quantity: number): Cart => ({ id: uuid(3), version, items: quantity === 0 ? [] : [{ id: uuid(4), product_id: product, quantity }] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function setup() {
  const reads: ReturnType<typeof deferred<Cart>>[] = [];
  const api = {
    getCart: vi.fn(() => { const read = deferred<Cart>(); reads.push(read); return read.promise; }),
    addCartItem: vi.fn(async () => cartAt(6, 2)),
  };
  const session = {
    getSnapshot: () => ({ revision: 1, status: 'authenticated', user: { id: uuid(1) } }),
    authorizedFor: (_revision: number, operation: (token: string, options: unknown) => Promise<unknown>, options: unknown) => operation('token', options),
    writeFor: (_revision: number, operation: (token: string, options: unknown) => Promise<unknown>, options: unknown) => operation('token', options),
    api,
  } as unknown as SessionController;
  const controller = new CartController(session, 1, uuid(1));
  controller.start(false);
  return { controller, api, reads };
}

// The two-tab race: this tab's first read is in flight when a peer tab adds the
// same product and its notice invalidates the cart, so a second read starts
// right after the first one settles. A click in that window must not be lost.
test('an add during a peer-triggered re-read waits for it and is sent exactly once', async () => {
  const { controller, api, reads } = setup();
  const first = controller.refresh();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  controller.invalidate();
  reads[0]!.resolve(cartAt(4, 0));
  expect(await first).toBe(true);
  await vi.waitFor(() => expect(reads).toHaveLength(2));

  // The plain write latch still refuses during a read and sends nothing.
  expect(await controller.change({ kind: 'add', productId: product, quantity: 1 })).toBe(false);
  expect(api.addCartItem).not.toHaveBeenCalled();

  const added = controller.changeAfterReads({ kind: 'add', productId: product, quantity: 1 });
  reads[1]!.resolve(cartAt(5, 1));
  expect(await added).toBe(true);
  expect(api.addCartItem).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().cart?.version).toBe(6);
});

test('a failed in-flight read still refuses the add without sending it', async () => {
  const { controller, api, reads } = setup();
  const pending = controller.refresh();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  const added = controller.changeAfterReads({ kind: 'add', productId: product, quantity: 1 });
  reads[0]!.resolve({ malformed: true } as unknown as Cart);
  expect(await pending).toBe(false);
  expect(await added).toBe(false);
  expect(api.addCartItem).not.toHaveBeenCalled();
});
