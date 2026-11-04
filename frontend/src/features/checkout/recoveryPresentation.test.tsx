import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { SessionBoundary } from '../auth/SessionBoundary';
import { safeReturnTo } from '../auth/returnTo';
import { anonymousApi, coordinatorHub } from '../../test/sessionDoubles';
import { RecoveryProvider } from './RecoveryProvider';
import { RecoveryPage } from './RecoveryPage';
import { recoveryScopeName } from './recoveryPersistence';
import type { RecoveryCoordinatorFactory } from './recoveryCoordination';

const id = (n: number) => `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const user = { id: id(1), first_name: 'Alex', last_name: 'River', email: 'unit@example.test', email_verified: true, role: 'customer', created_at: '2026-10-29T12:00:00Z' } as const;
const name = recoveryScopeName({ userId: user.id, apiBaseUrl: 'http://localhost:8080/api/v1' });
const original = { schema_version: 1, user_id: user.id, idempotency_key: id(3), request: { cart_version: 2, shipping_address_id: id(2), payment_scenario: 'accept' },
  created_at: '1970-01-01T00:00:00.000Z', phase: 'unresolved', generation: id(4), revision: 1 };
afterEach(() => { localStorage.clear(); });
function setup(path = '/checkout') {
  const api = anonymousApi(); api.refresh.mockResolvedValue({ access_token: 'unit.access', token_type: 'Bearer', expires_in: 900 }); api.getMe.mockResolvedValue(user);
  const notices: (() => void)[] = [];
  const factory: RecoveryCoordinatorFactory = (_name, _api, changed) => {
    notices.push(changed);
    return { exclusive: async (_signal, operation) => operation(), notify: vi.fn(), close: vi.fn() };
  };
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><AuthProvider api={api} coordinatorFactory={coordinatorHub().factory}>
    <RecoveryProvider factory={factory}><Routes><Route element={<SessionBoundary />}>
      <Route path="checkout" element={<RecoveryPage />} /><Route path="cart" element={<Link to="/checkout">Return to checkout</Link>} />
    </Route><Route path="verify-email" element={<p>Minimal link page</p>} /></Routes></RecoveryProvider>
  </AuthProvider></MemoryRouter></StrictMode>);
  return { api, notices, ...view };
}

test('restores a saved request with accurate submit-or-resolve guidance, no exposed key and no dead action', async () => {
  localStorage.setItem(name, JSON.stringify(original)); setup();
  await screen.findByRole('heading', { name: 'Original checkout saved' });
  expect(screen.getByText(/may find your existing order or submit the saved original request/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Resume Original Checkout' })).toBeTruthy();
  expect(document.body.textContent).not.toContain(original.idempotency_key); expect(localStorage.getItem(name)).toBe(JSON.stringify(original));
  fireEvent.click(screen.getByRole('link', { name: 'Review cart' })); await screen.findByRole('link', { name: 'Return to checkout' });
  fireEvent.click(screen.getByRole('link', { name: 'Return to checkout' })); await screen.findByRole('heading', { name: 'Original checkout saved' });
});

test('corrupt storage stays preserved through route changes and peer events; explicit valid recheck restores it', async () => {
  localStorage.setItem(name, '{'); const { notices } = setup();
  await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('unreadable');
  localStorage.setItem(name, JSON.stringify(original)); await act(async () => notices.forEach((notify) => notify()));
  expect(screen.queryByRole('heading', { name: 'Original checkout saved' })).toBeNull();
  const button = screen.getByRole('button', { name: 'Recheck saved checkout' }); button.focus(); fireEvent.click(button);
  await screen.findByRole('heading', { name: 'Original checkout saved' }); await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  expect(localStorage.getItem(name)).toBe(JSON.stringify(original));
});

test('a rejected checkout exposes owned history without inventing payment state', async () => {
  localStorage.setItem(name, JSON.stringify({ ...original, phase: 'rejected' })); setup();
  await screen.findByRole('heading', { name: 'Previous checkout refused' });
  expect(screen.getByRole('link', { name: 'Your orders' }).getAttribute('href')).toBe('/orders');
  expect(screen.queryByText('Payment succeeded')).toBeNull();
});

test('minimal link pages neither restore recovery metadata nor show its private state', async () => {
  localStorage.setItem(name, JSON.stringify(original)); const read = vi.spyOn(Storage.prototype, 'getItem'); setup('/verify-email');
  await screen.findByText('Minimal link page'); await Promise.resolve();
  expect(read).not.toHaveBeenCalledWith(name); expect(screen.queryByText('Original checkout saved')).toBeNull();
});

test('implemented checkout and order routes join safe login return destinations', () => {
  expect(safeReturnTo('?returnTo=%2Fcheckout')).toBe('/checkout');
  expect(safeReturnTo('?returnTo=%2Fcheckout%3Fkey%3Dsecret')).toBe('/');
  expect(safeReturnTo('?returnTo=%2Forders')).toBe('/orders');
});
