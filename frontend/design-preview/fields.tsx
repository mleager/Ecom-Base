import { useEffect, useRef } from 'react';
import type { ComponentProps } from 'react';
import { Input } from '@/shared/ui/primitives/input';
import type { Shipping } from './data';
import { usRegions } from './data';

export function Field({ label, error, ...props }: ComponentProps<'input'> & { id: string; label: string; error?: string }) {
  return <div className="field">
    <label htmlFor={props.id}>{label}{props.required ? ' (required)' : ''}</label>
    <Input {...props} aria-invalid={error ? true : undefined} aria-describedby={error ? props.id + '-error' : undefined} />
    {error && <p className="error-text" id={props.id + '-error'}>{error}</p>}
  </div>;
}

export function Errors({ messages }: { messages: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const populated = Object.keys(messages).length > 0;
  useEffect(() => { if (populated) ref.current?.focus(); }, [messages, populated]);
  if (!populated) return null;
  return <div role="alert" tabIndex={-1} ref={ref} className="alert alert--error">
    <h2 className="alert-title">Please check the form</h2>
    <ul>{Object.entries(messages).map(([id, message]) => <li key={id}><a href={'#' + id} onClick={event => {
      event.preventDefault(); document.getElementById(id)?.focus();
    }}>{message}</a></li>)}</ul>
  </div>;
}

export function validateShipping(value: Shipping, prefix: string, includeEmail: boolean) {
  const errors: Record<string, string> = {};
  if (includeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) errors[prefix + '-email'] = 'Enter a contact email address.';
  if (!value.recipient.trim()) errors[prefix + '-recipient'] = 'Enter a recipient name.';
  if (!value.line1.trim()) errors[prefix + '-line1'] = 'Enter an address line 1.';
  if (!value.city.trim()) errors[prefix + '-city'] = 'Enter a city.';
  if (!usRegions.includes(value.region.toUpperCase())) errors[prefix + '-region'] = 'Use a two-letter US state or DC code.';
  if (!/^\d{5}(-\d{4})?$/.test(value.zip)) errors[prefix + '-zip'] = 'Enter a five-digit ZIP code or ZIP+4.';
  return errors;
}

export function ShippingFields({ value, onChange, errors, prefix, includeEmail = true }: {
  value: Shipping;
  onChange: (value: Shipping) => void;
  errors: Record<string, string>;
  prefix: string;
  includeEmail?: boolean;
}) {
  const fields: { name: keyof Shipping; label: string; complete: string; required: boolean }[] = [
    ...(includeEmail ? [{ name: 'email' as const, label: 'Contact email', complete: 'email', required: true }] : []),
    { name: 'recipient', label: 'Recipient name', complete: 'shipping name', required: true },
    { name: 'line1', label: 'Address line 1', complete: 'shipping address-line1', required: true },
    { name: 'line2', label: 'Address line 2', complete: 'shipping address-line2', required: false },
    { name: 'city', label: 'City', complete: 'shipping address-level2', required: true },
    { name: 'region', label: 'State or DC code', complete: 'shipping address-level1', required: true },
    { name: 'zip', label: 'ZIP code', complete: 'shipping postal-code', required: true },
  ];
  return <div className="shipping-fields">{fields.map(field => {
    const id = prefix + '-' + field.name;
    return <Field key={field.name} id={id} name={field.name} label={field.label} autoComplete={field.complete}
      required={field.required} type={field.name === 'email' ? 'email' : 'text'} value={value[field.name]}
      maxLength={field.name === 'region' ? 2 : field.name === 'zip' ? 10 : 254}
      {...(errors[id] ? { error: errors[id] } : {})}
      onChange={event => onChange({ ...value, [field.name]: event.target.value })} />;
  })}<div className="field"><label htmlFor={prefix + '-country'}>Country</label>
    <Input id={prefix + '-country'} value="United States" readOnly /></div></div>;
}

export function AddressText({ value }: { value: Shipping }) {
  return <address>{value.recipient}<br />{value.line1}<br />{value.line2 && <>{value.line2}<br /></>}
    {value.city}, {value.region.toUpperCase()} {value.zip}<br />United States</address>;
}
