import { createRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useLocation } from 'react-router';
import { expect, test, vi } from 'vitest';
import { Button } from './button';
import { Input } from './input';
import { cn } from '@/shared/ui/utils';

test('buttons require explicit submit intent and disabled buttons cannot repeat an action', async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  const action = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  const view = render(<form onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <Button ref={ref} onClick={action}>Review</Button>
    <Button type="submit">Place order</Button>
  </form>);
  await user.click(screen.getByRole('button', { name: 'Review' }));
  expect(action).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
  expect(ref.current).toBe(document.activeElement);
  await user.click(screen.getByRole('button', { name: 'Place order' }));
  expect(submit).toHaveBeenCalledOnce();
  view.rerender(<Button onClick={action} disabled aria-busy>Review</Button>);
  await user.click(screen.getByRole('button', { name: 'Review' }));
  expect(action).toHaveBeenCalledOnce();
});

test('native button keyboard activation sends one action per deliberate Enter or Space', async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  render(<Button onClick={action}>Continue</Button>);
  await user.tab();
  await user.keyboard('{Enter}');
  expect(action).toHaveBeenCalledOnce();
  await user.keyboard(' ');
  expect(action).toHaveBeenCalledTimes(2);
});

test('asChild composes a real router link with its handler and ref without nesting controls', async () => {
  const user = userEvent.setup();
  const click = vi.fn();
  const ref = createRef<HTMLAnchorElement>();
  function Location() { return <output>{useLocation().pathname}</output>; }
  render(<MemoryRouter>
    <Location />
    <Button asChild variant="secondary"><Link ref={ref} to="/cart" onClick={click}>View cart</Link></Button>
  </MemoryRouter>);
  const link = screen.getByRole('link', { name: 'View cart' });
  expect(ref.current).toBe(link);
  expect(link.querySelector('button')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  await user.click(link);
  expect(click).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toBe('/cart');
});

test('the shared class merger replaces prefixed utility conflicts while retaining CSS Module classes', () => {
  expect(cn('field_123 tw:px-3 tw:disabled:bg-muted', false, 'tw:px-4', 'tw:disabled:bg-control'))
    .toBe('field_123 tw:px-4 tw:disabled:bg-control');
});

test('controlled inputs preserve exact text, refs, descriptions and native form values', async () => {
  const user = userEvent.setup();
  const ref = createRef<HTMLInputElement>();
  const saved = vi.fn();
  function Form() {
    const [password, setPassword] = useState('');
    return <form onSubmit={(event) => { event.preventDefault(); saved(new FormData(event.currentTarget).get('password')); }}>
      <label htmlFor="password">Password</label>
      <p id="hint">Spaces are preserved.</p>
      <Input ref={ref} id="password" name="password" type="password" autoComplete="new-password"
        aria-describedby="hint" value={password} onChange={(event) => setPassword(event.target.value)} />
      <Button type="submit">Save</Button>
    </form>;
  }
  render(<Form />);
  const input = screen.getByLabelText('Password');
  await user.type(input, '  a long password  ');
  expect(ref.current).toBe(input);
  expect(input.getAttribute('aria-describedby')).toBe('hint');
  expect(input.getAttribute('autocomplete')).toBe('new-password');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(saved).toHaveBeenCalledExactlyOnceWith('  a long password  ');
});

test('disabled and invalid inputs retain native semantics and do not accept edits', async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<>
    <label htmlFor="email">Email</label>
    <p id="email-error">Check this email.</p>
    <Input id="email" type="email" value="first@example.test" disabled required
      aria-invalid="true" aria-describedby="email-error" onChange={change} />
  </>);
  const email = screen.getByRole('textbox', { name: 'Email' });
  await user.type(email, 'replacement');
  expect(change).not.toHaveBeenCalled();
  expect(email).toHaveProperty('value', 'first@example.test');
  expect(email).toHaveProperty('disabled', true);
  expect(email.getAttribute('aria-invalid')).toBe('true');
  expect(email.getAttribute('aria-describedby')).toBe('email-error');
});
