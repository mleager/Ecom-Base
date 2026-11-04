import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { expect, test, vi } from 'vitest';
import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';
import { anonymousApi, testCoordinator } from '../test/sessionDoubles';

function TestApp() { return <App api={anonymousApi()} coordinatorFactory={testCoordinator} />; }

function HistoryControls() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>Go back</button>
      <output aria-label="Current URL">{location.pathname}{location.search}</output>
    </>
  );
}

test('renders public navigation, one main heading and a keyboard skip link', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><TestApp /></MemoryRouter>);
  await screen.findByRole('link', { name: 'Create an account' });

  const main = screen.getByRole('main');
  const heading = within(main).getByRole('heading', { level: 1, name: 'Everyday essentials' });
  expect(document.title).toBe('Commerce Lab');
  expect(document.activeElement).toBe(heading);
  expect(within(screen.getByRole('navigation')).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');

  const skip = screen.getByRole('link', { name: 'Skip to content' });
  skip.focus();
  expect(document.activeElement).toBe(skip);
  expect(skip.getAttribute('href')).toBe('#main-content');
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Commerce Lab' }));
});

test('direct unknown URLs have a missing view and working home navigation', async () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/missing']}><TestApp /></MemoryRouter>);

  expect(document.title).toBe('Page not found | Commerce Lab');
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Page not found' }));
  await user.click(screen.getByRole('link', { name: 'Return home' }));
  await waitFor(() => expect(document.title).toBe('Commerce Lab'));
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Everyday essentials' }));
  expect(scroll).toHaveBeenCalledOnce();
});

test('skip navigation focuses main without a hash/history navigation or another catalog read', async () => {
  const api = anonymousApi();
  api.listProducts.mockResolvedValue([{
    id: 'f1000000-0000-4000-8000-000000000001', sku: 'LAMP-AMBER', name: 'Amber Desk Lamp',
    unit_price_cents: 3499, is_active: true, available_quantity: 50,
  }]);
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/?q=lamp']}><HistoryControls /><App api={api} coordinatorFactory={testCoordinator} /></MemoryRouter>);
  await screen.findByRole('link', { name: 'Amber Desk Lamp' });
  await user.click(screen.getByRole('link', { name: 'Skip to content' }));
  expect(document.activeElement).toBe(screen.getByRole('main'));
  expect(screen.getByLabelText('Current URL').textContent).toBe('/?q=lamp');
  expect(window.location.hash).toBe('');
  expect(api.listProducts).toHaveBeenCalledOnce();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Quick view Amber Desk Lamp' }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Amber Desk Lamp' }));
});

test('back navigation retains the original query and does not force scroll to the top', async () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/?q=lamp&offset=20', '/missing']}>
      <HistoryControls />
      <TestApp />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Go back' }));
  expect(screen.getByLabelText('Current URL').textContent).toBe('/?q=lamp&offset=20');
  expect(document.title).toBe('Commerce Lab');
  expect(scroll).not.toHaveBeenCalled();
});

test('a render failure shows recovery controls without rendering error details', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  function BrokenPage(): never { throw new Error('private backend detail'); }
  render(<AppErrorBoundary><BrokenPage /></AppErrorBoundary>);

  expect(screen.getByRole('alert').textContent).not.toContain('private backend detail');
  expect(document.title).toBe('Something went wrong | Commerce Lab');
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeInstanceOf(HTMLButtonElement);
  expect(screen.getByRole('link', { name: 'Return home' }).getAttribute('href')).toBe('/');
});
