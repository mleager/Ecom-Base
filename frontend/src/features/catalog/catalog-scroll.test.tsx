import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { expect, test, vi } from 'vitest';
import { useCatalogScroll } from './useCatalogScroll';

function Probe({ ready }: { ready: boolean }) {
  useCatalogScroll(ready);
  return <output>{useLocation().key}</output>;
}
function Harness({ ready, positions }: { ready: boolean; positions: Map<string, number> }) {
  return <MemoryRouter initialEntries={[{ pathname: '/', key: 'catalog-entry' }]}>
    <Routes><Route element={<Outlet context={{ catalogScroll: positions }} />}>
      <Route index element={<Probe ready={ready} />} />
    </Route></Routes>
  </MemoryRouter>;
}

test('a POP waits for ready results and ignores loader-induced scrolling before restoring', () => {
  const positions = new Map([['catalog-entry', 900]]);
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const view = render(<Harness ready={false} positions={positions} />);
  fireEvent.scroll(window);
  expect(positions.get('catalog-entry')).toBe(900);
  expect(scroll).not.toHaveBeenCalled();
  view.rerender(<Harness ready positions={positions} />);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 900, left: 0, behavior: 'auto' });
});

test('new user interaction cancels a pending restoration instead of overriding their position', () => {
  const positions = new Map([['catalog-entry', 900]]);
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const view = render(<Harness ready={false} positions={positions} />);
  fireEvent.wheel(window);
  view.rerender(<Harness ready positions={positions} />);
  expect(scroll).not.toHaveBeenCalled();
});

test('public scroll entries stay bounded and event handlers stop recording after unmount', () => {
  const positions = new Map(Array.from({ length: 50 }, (_, index) => [`older-${index}`, index]));
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(700);
  const view = render(<Harness ready positions={positions} />);
  expect(screen.getByText('catalog-entry')).toBeInstanceOf(HTMLElement);
  fireEvent.scroll(window);
  expect(positions.size).toBe(50);
  expect(positions.has('older-0')).toBe(false);
  expect(positions.get('catalog-entry')).toBe(700);
  view.unmount();
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(0);
  fireEvent.scroll(window);
  expect(positions.get('catalog-entry')).toBe(700);
});
