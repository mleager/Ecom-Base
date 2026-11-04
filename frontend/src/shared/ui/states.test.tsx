import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';
import { AsyncState } from './AsyncState';
import { Field } from './Field';
import { FormErrorSummary } from './FormErrorSummary';
import { FormLayout } from './FormLayout';
import { Notice } from './Notice';

test('a field associates its label, existing description, hint and error', () => {
  render(
    <>
      <p id="context">Used for signing in.</p>
      <Field id="email" name="email" type="email" label="Email" required
        hint="Use your email address." error="Enter a valid email." aria-describedby="context" />
    </>,
  );
  const field = screen.getByRole('textbox', { name: 'Email (required)' });
  expect(field.getAttribute('aria-describedby')).toBe('context email-hint email-error');
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('Enter a valid email.').id).toBe('email-error');
});

test('error summary focuses on failure and its field links move focus without navigating', async () => {
  const user = userEvent.setup();
  render(
    <>
      <FormErrorSummary issues={[
        { message: 'Enter an email.', fieldId: 'email' },
        { message: 'Please try again later.' },
      ]} />
      <Field id="email" label="Email" />
    </>,
  );
  expect(document.activeElement).toBe(screen.getByRole('alert'));
  await user.click(screen.getByRole('link', { name: 'Enter an email.' }));
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Email' }));
  expect(window.location.hash).toBe('');
});

test('an empty summary is absent and successful notices announce without stealing focus', () => {
  render(<><FormErrorSummary issues={[]} /><Notice tone="success">Saved.</Notice></>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Saved.');
  expect(document.activeElement).not.toBe(screen.getByRole('status'));
});

test('an uncertain-outcome warning remains an alert without taking keyboard focus', () => {
  const { rerender } = render(<button type="button">Check saved state</button>);
  const action = screen.getByRole('button'); action.focus();
  rerender(<><button type="button">Check saved state</button><Notice tone="warning">The change is unconfirmed. Review saved state before another action.</Notice></>);
  expect(screen.getByRole('alert').textContent).toContain('unconfirmed');
  expect(screen.getByRole('alert').classList.contains('notice-warning')).toBe(true);
  expect(document.activeElement).toBe(action);
});

test('async states distinguish loading, empty, failed and ready content', async () => {
  const user = userEvent.setup();
  const retry = vi.fn();
  const { rerender } = render(<AsyncState kind="loading" message="Loading products…" />);
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');

  rerender(<AsyncState kind="empty" message="No products found." />);
  expect(screen.getByText('No products found.')).toBeInstanceOf(HTMLParagraphElement);
  expect(screen.queryByRole('alert')).toBeNull();

  rerender(<AsyncState kind="error" message="Products could not be loaded." onRetry={retry} />);
  expect(retry).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalledOnce();

  rerender(<AsyncState kind="ready"><p>Products loaded.</p></AsyncState>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Products loaded.')).toBeInstanceOf(HTMLParagraphElement);
});

test('form layout supplies the page heading and preserves native form submission', async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  render(
    <MemoryRouter>
      <FormLayout title="Example form">
        <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <Field id="name" label="Name" name="name" required />
          <button type="submit">Save</button>
        </form>
      </FormLayout>
    </MemoryRouter>,
  );
  await user.type(screen.getByRole('textbox', { name: 'Name (required)' }), 'Alex');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(submit).toHaveBeenCalledOnce();
  expect(document.title).toBe('Example form | Commerce Lab');
});
