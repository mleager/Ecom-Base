import { isObject, isUuid } from './api/contracts';
import type { Address, AddressFields, AddressInput, AddressPatch } from './api/contracts';

export const addressFields = [
  { key: 'label', label: 'Address label', limit: 80, required: false, autocomplete: 'off' },
  { key: 'recipient_name', label: 'Recipient name', limit: 200, required: true, autocomplete: 'shipping name' },
  { key: 'line_1', label: 'Address line 1', limit: 200, required: true, autocomplete: 'shipping address-line1' },
  { key: 'line_2', label: 'Address line 2', limit: 200, required: false, autocomplete: 'shipping address-line2' },
  { key: 'city', label: 'City', limit: 100, required: true, autocomplete: 'shipping address-level2' },
  { key: 'region', label: 'State or DC code', limit: 2, required: true, autocomplete: 'shipping address-level1' },
  { key: 'postal_code', label: 'ZIP code', limit: 10, required: true, autocomplete: 'shipping postal-code' },
] as const;

const states = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

export const emptyAddress: AddressFields = { label: '', recipient_name: '', line_1: '', line_2: '', city: '', region: '', postal_code: '' };

export function normalizeAddressField(key: keyof AddressFields, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.includes('\0') || Array.from(raw).some((character) => {
    const point = character.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff;
  })) return null;
  let value = raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  const field = addressFields.find((item) => item.key === key)!;
  if (Array.from(value).length > field.limit || field.required && value === '') return null;
  if (key === 'region') { value = value.toUpperCase(); if (!states.has(value)) return null; }
  if (key === 'postal_code' && !/^[0-9]{5}(-[0-9]{4})?$/.test(value)) return null;
  return value;
}

export function addressBody(input: unknown, create: boolean): AddressInput | AddressPatch | null {
  if (!isObject(input)) return null;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !addressFields.some((field) => field.key === key) && !(create && key === 'country_code'))) return null;
  if (create && 'country_code' in input && input.country_code !== 'US') return null;
  const result: AddressPatch = {};
  for (const field of addressFields) {
    if (!(field.key in input)) { if (create && field.required) return null; continue; }
    const value = normalizeAddressField(field.key, input[field.key]);
    if (value === null) return null;
    result[field.key] = value;
  }
  return create ? { ...result, country_code: 'US' } as AddressInput : result;
}

export function parseAddress(value: unknown): Address | null {
  if (!isObject(value) || !isUuid(value.id) || value.country_code !== 'US'
    || Object.keys(value).some((key) => key !== 'id' && key !== 'country_code' && !addressFields.some((field) => field.key === key))) return null;
  const fields = { ...emptyAddress };
  for (const field of addressFields) {
    const raw = value[field.key] === undefined && !field.required ? '' : value[field.key];
    const normalized = normalizeAddressField(field.key, raw);
    if (normalized === null || normalized !== raw) return null;
    fields[field.key] = normalized;
  }
  return { ...fields, id: value.id, country_code: 'US' };
}
