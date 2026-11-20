// @vitest-environment node
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { expect, expectTypeOf, test } from 'vitest';
import { adminOperations, addressOperations, authOperations, cartOperations, catalogOperations, checkoutOperations, recoveryOperations, securityOperations } from './contracts';
import type { ApiClient } from './client';
import { guestOperations } from './guest';
import type { PasswordChangeInput, SecurityChangeResult } from './contracts';
import type { AccessToken, ApiErrorBody, LoginInput, Product, ProductPageInput, ProfilePatch, RegisterInput, User } from './contracts';

const openapi = readFileSync(new URL('../../../../docs/api/openapi.yaml', import.meta.url), 'utf8').replace(/\r/g, '');
const inventoryURL = new URL('../../../../docs/frontend/API_INTEGRATION.md', import.meta.url);
const businessOperations = { ...authOperations, ...catalogOperations, ...addressOperations, ...securityOperations, ...recoveryOperations, ...cartOperations, ...checkoutOperations, ...adminOperations };
const guestFoundation = [
  ['GET', '/guest/session', 'getGuestSession'], ['POST', '/guest/session', 'createGuestSession'], ['DELETE', '/guest/session', 'endGuestSession'],
  ['POST', '/guest/session/rotate', 'rotateGuestSession'], ['GET', '/guest/cart', 'getGuestCart'], ['POST', '/guest/cart/items', 'addGuestCartItem'],
  ['DELETE', '/guest/cart/items', 'clearGuestCart'], ['PATCH', '/guest/cart/items/{id}', 'replaceGuestCartItem'], ['DELETE', '/guest/cart/items/{id}', 'removeGuestCartItem'],
  ['GET', '/guest/cart-choice', 'getGuestCartChoice'], ['POST', '/guest/cart-choice', 'chooseGuestCart'],
] as const;
const guestCheckout = [
  ['POST', '/guest/checkout-intents', 'prepareGuestCheckout'], ['GET', '/guest/checkout-intents/{id}', 'getGuestCheckoutIntent'],
  ['POST', '/guest/checkout-intents/{id}/retire', 'retireGuestCheckoutIntent'], ['POST', '/guest/checkout', 'checkoutGuest'],
  ['GET', '/guest/orders', 'listGuestOrders'], ['GET', '/guest/orders/{id}', 'getGuestOrder'],
  ['GET', '/guest/orders/{id}/payments', 'getGuestOrderPayments'], ['POST', '/guest/orders/{id}/cancel', 'cancelGuestOrder'],
  ['POST', '/guest/recovery-requests', 'requestGuestRecovery'], ['POST', '/guest/recovery-confirmations', 'confirmGuestRecovery'],
  ['GET', '/guest/recovery-access', 'getGuestRecoveryAccess'], ['DELETE', '/guest/recovery-access', 'endGuestRecoveryAccess'],
] as const;

test('every operation has an inventory owner across frontend methods, guest backend methods and operational checks', () => {
  const methods = new Set<string>(); let path = '';
  for (const line of block(openapi, 'paths:').split('\n')) {
    const entry = /^  (\/[^:]+):$/.exec(line); if (entry) path = entry[1]!;
    const method = /^    (get|put|post|delete|options|head|patch|trace):$/.exec(line); if (method) methods.add(`${method[1]!.toUpperCase()} ${path}`);
  }
  const inventory = readFileSync(new URL('../../../../docs/frontend/API_INTEGRATION.md', import.meta.url), 'utf8');
  const rows = [...inventory.matchAll(/^\| `((?:GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE) \/[^`]+)` \|/gm)].map((match) => match[1]!);
  expect(rows).toHaveLength(64); expect(new Set(rows)).toEqual(methods);
  const implemented = new Set([adminOperations, authOperations, catalogOperations, cartOperations, addressOperations, securityOperations, recoveryOperations, checkoutOperations]
    .flatMap((operations) => Object.values(operations).map((operation) => `${operation.method} ${operation.path}`)));
  expect(implemented.size).toBe(38);
  const operational = new Set(['GET /health/live', 'GET /health/ready', 'GET /metrics']);
  expect(methods).toEqual(new Set([...implemented, ...operational, ...[...guestFoundation, ...guestCheckout].map(([method, path]) => `${method} ${path}`)]));
});

test('guest session and cart operations are inventoried with their backend and browser tests', () => {
  const inventory = readFileSync(inventoryURL, 'utf8').split('## Guest session and cart')[1]!.split('\n## ')[0]!;
  const signatures = [...inventory.matchAll(/^\| `((?:GET|POST|PATCH|DELETE) \/[^`]+)` \|/gm)].map((match) => match[1]!);
  expect(new Set(signatures)).toEqual(new Set(guestFoundation.map(([method, path]) => `${method} ${path}`)));
  for (const [method, path, name] of guestFoundation) {
    const item = block(openapi, `  ${path}:`);
    const operation = block(item, `    ${method.toLowerCase()}:`);
    expect(operation).toContain(`operationId: ${name}`); expect(operation).not.toContain('guestRecoveryCookie');
    const shared = item.split(/^    (?:get|post|patch|delete):$/m)[0]!;
    if (method !== 'GET') expect(operation + shared).toContain('CsrfProtection');
  }
  expect(inventory).toContain('guest_test.go'); expect(inventory).toContain('guest-contract.spec.ts');
});

test('all guest client methods match the declared paths, statuses and browser protection', () => {
  expectTypeOf<keyof ApiClient['guest']>().toEqualTypeOf<keyof typeof guestOperations>();
  const declared = [...guestFoundation, ...guestCheckout];
  expect(Object.values(guestOperations)).toHaveLength(declared.length);
  for (const operation of Object.values(guestOperations)) {
    const match = declared.find(([method, path]) => method === operation.method && path === operation.path);
    expect(match).toBeDefined();
    const item = block(block(openapi, `  ${operation.path}:`), `    ${operation.method.toLowerCase()}:`);
    expect(item).toContain(`operationId: ${match![2]}`);
    for (const status of [operation.status, operation.pendingStatus, operation.replayStatus]) {
      if (status !== undefined) expect(item).toContain(`        '${status}':`);
    }
    expect(operation.cookies).toBe(true);
    expect(operation.csrf).toBe(operation.method !== 'GET');
  }
});

test('guest checkout operations define exact credential boundaries and write guards', () => {
  const inventory = readFileSync(inventoryURL, 'utf8').split('## Guest checkout and recovery')[1]!.split('\n## ')[0]!;
  const signatures = [...inventory.matchAll(/^\| `((?:GET|POST|DELETE) \/[^`]+)` \|/gm)].map((match) => match[1]!);
  expect(new Set(signatures)).toEqual(new Set(guestCheckout.map(([method, path]) => `${method} ${path}`)));
  const fullOnly = new Set<string>(['prepareGuestCheckout', 'listGuestOrders']);
  const publicProof = new Set<string>(['requestGuestRecovery', 'confirmGuestRecovery', 'endGuestRecoveryAccess']);
  for (const [method, path, name] of guestCheckout) {
    const item = block(openapi, `  ${path}:`);
    const operation = block(item, `    ${method.toLowerCase()}:`);
    expect(operation).toContain(`operationId: ${name}`);
    expect(operation).not.toContain('bearerAuth');
    if (method !== 'GET') expect(operation).toContain('CsrfProtection');
    if (fullOnly.has(name)) {
      expect(operation).toContain('guestCookie');
      expect(operation).not.toContain('guestRecoveryCookie');
    } else if (publicProof.has(name)) {
      expect(operation).toContain('security: []');
    } else {
      expect(operation).toContain('guestRecoveryCookie');
      expect(operation.includes('guestCookie')).toBe(name !== 'getGuestRecoveryAccess');
    }
  }
});

test('every business method matches its OpenAPI identity and declared successful statuses, including the two intentional aliases', () => {
  expectTypeOf<keyof Omit<ApiClient, 'guest'>>().toEqualTypeOf<keyof typeof businessOperations>();
  const aliases: Readonly<Record<string, string>> = { replaceCartItem: 'updateCartItem', cancelOrder: 'cancelPendingOrder' };
  for (const [name, operation] of Object.entries(businessOperations)) {
    const method = block(block(openapi, `  ${operation.path}:`), `    ${operation.method.toLowerCase()}:`);
    expect(method, name).toContain(`operationId: ${aliases[name] ?? name}`);
    const statuses = [operation.status, ...('pendingStatus' in operation ? [operation.pendingStatus] : []), ...('replayStatus' in operation ? [operation.replayStatus] : [])];
    for (const status of statuses) expect(method, name).toContain(`        '${status}':`);
  }
});

test('the operation inventory links every business method to its production caller, unit test and browser test, with separate operator evidence', () => {
  const inventory = readFileSync(inventoryURL, 'utf8');
  const business = inventory.split('## Accounts and security')[1]!.split('## Guest session and cart')[0]!;
  const operational = inventory.split('## Operational routes')[1]!;
  const rows = business!.split('\n').filter((line) => /^\| `(?:GET|POST|PATCH|DELETE) \//.test(line));
  expect(rows).toHaveLength(38);
  const byEndpoint = new Map(Object.entries(businessOperations).map(([name, operation]) => [`${operation.method} ${operation.path}`, name]));
  const covered = new Set<string>();
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    expect(cells, row).toHaveLength(4);
    const signature = cells[0]!.slice(1, -1); const name = byEndpoint.get(signature);
    expect(name, signature).toBeDefined();
    expect(covered.has(name!), signature).toBe(false); covered.add(name!);
    const caller = /^\[`(\w+)`\]\((\.\.\/\.\.\/frontend\/src\/features\/[^)]+)\)$/.exec(cells[1]!);
    expect(caller, signature).not.toBeNull(); expect(caller![1]).toBe(name);
    expect(caller![2]).not.toContain('.test.');
    expect(readFileSync(new URL(caller![2]!, inventoryURL), 'utf8'), signature).toContain(`.${name}(`);
    expect(cells[2]!.length, signature).toBeGreaterThan(0);
    const links = [...cells[3]!.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    expect(links, signature).toHaveLength(2);
    expect(links[0], signature).toMatch(/^\.\.\/\.\.\/frontend\/src\/features\/.+\.test\.tsx?$/);
    expect(links[1], signature).toMatch(/^\.\.\/\.\.\/frontend\/tests\/e2e\/.+\.spec\.ts$/);
    for (const link of links) expect(readFileSync(new URL(link, inventoryURL), 'utf8'), link).toMatch(/\btest(?:\.each)?\(/);
    expect(readFileSync(new URL(links[1]!, inventoryURL), 'utf8'), signature).toContain("from './backend'");
  }
  expect(covered).toEqual(new Set(Object.keys(businessOperations)));
  const operatorRows = operational.split('\n').filter((line) => /^\| `GET \//.test(line));
  expect(operatorRows).toHaveLength(3);
  for (const row of operatorRows) {
    const links = [...row.matchAll(/\[(Test\w+)\]\((\.\.\/\.\.\/backend\/[^)]+_test\.go)\)/g)];
    expect(links.length, row).toBeGreaterThan(0);
    for (const link of links) expect(readFileSync(new URL(link[2]!, inventoryURL), 'utf8')).toContain(`func ${link[1]}(t *testing.T)`);
  }
});

test('all seven administrator operations retain exact bearer-only OpenAPI methods/statuses and schema bounds', () => {
  expect(Object.keys(adminOperations)).toHaveLength(7);
  for (const [name, operation] of Object.entries(adminOperations)) {
    const method = block(block(openapi, `  ${operation.path}:`), `    ${operation.method.toLowerCase()}:`);
    expect(method).toContain(`operationId: ${name}`); expect(method).toContain(`        '${operation.status}':`);
    expect(operation.cookies).toBe(false); expect(method).not.toContain('CsrfProtection');
    expect(method).toContain("'401'"); expect(method).toContain("'403'");
  }
  const create = block(openapi, '    ProductInput:');
  expect(create).toContain('required: [sku, name, unit_price_cents]'); expect(create).not.toContain('is_active');
  expect(create).toContain('additionalProperties: false'); expect(create).toContain('maximum: 1000000000000');
  expect(block(openapi, '    ProductPatch:')).toContain('minProperties: 1');
  const stock = block(block(openapi, '  /admin/products/{id}/inventory:'), '    patch:');
  expect(stock).toContain('minimum: -2147483647, maximum: 2147483647');
});

test('cart operations preserve the existing add/replace semantics, bounds and bodyless delete contract', () => {
  for (const [name, operation] of Object.entries(cartOperations)) {
    const method = block(block(openapi, `  ${operation.path}:`), `    ${operation.method.toLowerCase()}:`);
    // The client calls PATCH "replace" to distinguish it from additive POST;
    // its existing OpenAPI operation ID is updateCartItem.
    expect(method).toContain(`operationId: ${name === 'replaceCartItem' ? 'updateCartItem' : name}`);
    expect(method).toContain(`        '${operation.status}':`); expect(operation.cookies).toBe(false);
    expect(method).not.toContain('CsrfProtection');
    if (operation.method === 'DELETE') expect(method).not.toContain('application/json');
  }
  const add = block(block(openapi, '  /cart/items:'), '    post:');
  expect(add).toContain('Adds quantity'); expect(add).toContain('required: [product_id, quantity]');
  const replace = block(block(openapi, '  /cart/items/{id}:'), '    patch:');
  expect(replace).toContain('Replaces item quantity'); expect(replace).toContain('required: [quantity]');
  expect(block(openapi, '    CartItem:')).toContain('quantity: { type: integer, minimum: 1, maximum: 10000 }');
  expect(block(openapi, '    Cart:')).toContain('maxItems: 100');
  expect(block(openapi, '    Cart:')).toContain('maximum: 9007199254740991');
});

test('address CRUD uses existing bearer-only contracts, strict patches and bodyless deletion', () => {
  for (const [name, operation] of Object.entries(addressOperations)) {
    const method = block(block(openapi, `  ${operation.path}:`), `    ${operation.method.toLowerCase()}:`);
    expect(method).toContain(`operationId: ${name}`); expect(method).toContain(`        '${operation.status}':`); expect(operation.cookies).toBe(false);
    expect(method).not.toContain('CsrfProtection');
  }
  const patch = block(openapi, '    AddressPatch:');
  expect(patch).toContain('minProperties: 1'); expect(patch).toContain('additionalProperties: false'); expect(patch).not.toContain('country_code');
});

test('public recovery contracts require CSRF without session credentials and define strict request/result bodies', () => {
  for (const [name, operation] of Object.entries(recoveryOperations)) {
    const method = block(block(openapi, `  ${operation.path}:`), '    post:');
    expect(method).toContain(`operationId: ${name}`); expect(method).toContain(`        '${operation.status}':`);
    expect(method).toContain('security: []'); expect(method).toContain('#/components/parameters/BrowserOrigin'); expect(method).toContain('#/components/parameters/CsrfProtection');
    expect(operation.csrf).toBe(true); expect(operation.cookies).toBe(false);
  }
  expect(block(openapi, '    PasswordResetInput:')).toContain('required: [token, new_password]');
  expect(block(openapi, '    PasswordResetResult:')).toContain('enum: [accepted, unconfirmed]');
  expect(block(openapi, '    PasswordResetReceipt:')).toContain('If this address is eligible, recovery instructions will be sent.');
});

test('email-change contracts require dual proofs, explicit cancellation and separate pending/completed statuses', () => {
  for (const name of ['requestEmailChange', 'confirmEmailChange', 'cancelEmailChange'] as const) {
    const operation = securityOperations[name];
    const method = block(block(openapi, `  ${operation.path}:`), '    post:');
    expect(method).toContain(`operationId: ${name}`);expect(method).toContain(`        '${operation.status}':`);
    expect(method).toContain('#/components/parameters/CsrfProtection');expect(operation.cookies).toBe(true);
    expect(method).toContain('Never');
  }
  const confirmation = block(openapi, '  /users/me/email-change/confirm:');
  expect(confirmation).toContain("        '202':");expect(confirmation).toContain('savepoint');
  expect(block(openapi, '    EmailChangeInput:')).toContain('required: [new_email, current_password]');
  expect(block(openapi, '    EmailChangeCancellation:')).toContain('required: [request_id, current_password]');
});

test('verification and owned security status endpoint metadata match OpenAPI', () => {
  for (const name of ['getSecurity', 'requestVerification', 'confirmVerification'] as const) {
    const operation = securityOperations[name];
    const method = block(block(openapi, `  ${operation.path}:`), `    ${operation.method.toLowerCase()}:`);
    expect(method).toContain(`operationId: ${name}`);
    expect(method).toContain(`        '${operation.status}':`);
    expect(method.includes("#/components/parameters/CsrfProtection")).toBe(operation.csrf);
  }
  expect(block(openapi, '    VerificationConfirmation:')).toContain('required: [token, current_password]');
  expect(block(openapi, '    SecurityStatus:')).toContain('required: [email_delivery_available, pending_email_change]');
});

// These focused source assertions intentionally fail when the selected contract
// blocks change. They do not parse arbitrary YAML or replace full OpenAPI validation.
function block(source: string, header: string): string {
  const lines = source.split('\n');
  const start = lines.indexOf(header);
  if (start < 0) throw new Error(`Missing OpenAPI contract block: ${header.trim()}`);
  const indent = header.length - header.trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() && line.length - line.trimStart().length <= indent) break;
    end++;
  }
  return lines.slice(start, end).join('\n');
}

test('password-change contract requires current/replacement secrets, CSRF and explicit reauthentication', () => {
  const operation = securityOperations.changePassword;
  const method = block(block(openapi, `  ${operation.path}:`), '    post:');
  expect(method).toContain('operationId: changePassword');
  expect(method).toContain("        '200':");
  expect(method).toContain("#/components/parameters/BrowserOrigin");
  expect(method).toContain("#/components/parameters/CsrfProtection");
  expect(method).toContain('Never automatically replay this write');
  expect(operation.cookies && operation.csrf).toBe(true);
  const input = block(openapi, '    PasswordChangeInput:');
  expect(input).toContain('additionalProperties: false');
  expect(input).toContain('required: [current_password, new_password]');
  expect(input).toContain('At most 512 UTF-8 bytes; never trimmed or normalized');
  expect(block(openapi, '    SecurityChangeResult:')).toContain('reauthentication_required: { type: boolean, enum: [true] }');
  expectTypeOf<PasswordChangeInput>().toEqualTypeOf<{ current_password: string; new_password: string }>();
  expectTypeOf<SecurityChangeResult>().toEqualTypeOf<{ reauthentication_required: true; notification: 'accepted' | 'unconfirmed' | 'not_applicable' }>();
});

test('profile PATCH permits only optional name strings and requires at least one field', () => {
  const method = block(block(openapi, '  /users/me:'), '    patch:');
  expect(method).toContain('additionalProperties: false');
  expect(method).toContain('minProperties: 1');
  expect(method).not.toContain('required: [first_name');
  expect(block(method, '              properties:').split('\n').slice(1)).toEqual([
    '                first_name: { type: string, minLength: 1, maxLength: 200 }',
    '                last_name: { type: string, minLength: 1, maxLength: 200 }',
  ]);
  expect(method).toContain("schema: { $ref: '#/components/schemas/User' }");
  expectTypeOf<ProfilePatch>().toEqualTypeOf<{ first_name?: string; last_name?: string }>();
});

test('auth/profile endpoint methods, paths, statuses and credential policy match OpenAPI', () => {
  for (const [name, operation] of Object.entries(authOperations)) {
    const path = block(openapi, `  ${operation.path}:`);
    const method = block(path, `    ${operation.method.toLowerCase()}:`);
    expect(method).toContain(`operationId: ${name}`);
    expect(method).toContain(`        '${operation.status}':`);
    expect(method.includes("$ref: '#/components/parameters/BrowserOrigin'")).toBe(operation.cookies);
    expect(method.includes("$ref: '#/components/parameters/CsrfProtection'")).toBe(operation.cookies);
  }
  expect(block(openapi, '  /auth/register:')).toContain("#/components/schemas/User");
  expect(block(openapi, '  /auth/login:')).toContain("#/components/schemas/AccessToken");
  expect(block(openapi, '  /auth/refresh:')).toContain("#/components/schemas/AccessToken");
  expect(block(openapi, '    CsrfProtection:')).toContain("enum: ['1']");
  expect(block(openapi, '  /auth/logout:')).not.toContain('application/json');
});

test.each([
  {
    name: 'RegisterInput', required: ['first_name', 'last_name', 'email', 'password'],
    properties: [
      'first_name: { type: string, minLength: 1, maxLength: 200 }',
      'last_name: { type: string, minLength: 1, maxLength: 200 }',
      'email: { type: string, format: email, maxLength: 254 }',
      'password: { type: string, minLength: 15, maxLength: 128, description: At most 512 UTF-8 bytes; never trimmed or normalized }',
    ],
  },
  {
    name: 'LoginInput', required: ['email', 'password'],
    properties: [
      'email: { type: string, format: email, maxLength: 254 }',
      'password: { type: string, minLength: 15, maxLength: 128 }',
    ],
  },
  {
    name: 'User', required: ['id', 'first_name', 'last_name', 'email', 'role', 'email_verified', 'created_at'],
    properties: [
      'id: { type: string, format: uuid }', 'first_name: { type: string }',
      'last_name: { type: string }', 'email: { type: string, format: email }',
      'role: { type: string, enum: [customer, admin] }',
      'email_verified: { type: boolean }',
      'created_at: { type: string, format: date-time }',
    ],
  },
  {
    name: 'AccessToken', required: ['access_token', 'token_type', 'expires_in'],
    properties: [
      'access_token: { type: string }', 'token_type: { type: string, enum: [Bearer] }',
      'expires_in: { type: integer, enum: [900] }',
    ],
  },
  {
    name: 'Error', required: ['code', 'message'],
    properties: [
      'code: { type: string, example: insufficient_inventory }', 'message: { type: string }',
    ],
  },
])('$name wire fields and validation metadata remain aligned', ({ name, required, properties }) => {
  const schema = block(openapi, `    ${name}:`);
  const requiredFields = /required: \[([^\]]*)\]/.exec(schema)?.[1]?.split(', ');
  expect(requiredFields).toEqual(required);
  expect(schema.split('\n').filter((line) => /^        \w+:/.test(line)).map((line) => line.trim())).toEqual(properties);
  if (name === 'RegisterInput' || name === 'LoginInput') {
    expect(schema).toContain('additionalProperties: false');
  }
});

test('TypeScript DTOs preserve required fields and literal enums', () => {
  expectTypeOf<RegisterInput>().toEqualTypeOf<{ first_name: string; last_name: string; email: string; password: string }>();
  expectTypeOf<LoginInput>().toEqualTypeOf<{ email: string; password: string }>();
  expectTypeOf<User>().toEqualTypeOf<{
    id: string; first_name: string; last_name: string; email: string;
    role: 'customer' | 'admin'; email_verified: boolean; created_at: string;
  }>();
  expectTypeOf<AccessToken>().toEqualTypeOf<{ access_token: string; token_type: 'Bearer'; expires_in: 900 }>();
  expectTypeOf<ApiErrorBody>().toEqualTypeOf<{ code: string; message: string }>();
});

test('public catalog list operation, pagination and Product fields match OpenAPI', () => {
  const operation = catalogOperations.listProducts;
  const endpoint = block(openapi, `  ${operation.path}:`);
  const method = block(endpoint, `    ${operation.method.toLowerCase()}:`);
  expect(operation.cookies).toBe(false);
  expect(method).toContain('security: []');
  expect(method).toContain('operationId: listProducts');
  expect(method).toContain(`        '${operation.status}':`);
  expect(method).toContain('type: array');
  expect(method).toContain("items: { $ref: '#/components/schemas/Product' }");
  expect(method).toContain('schema: { type: integer, minimum: 1, maximum: 100, default: 20 }');
  expect(method).toContain('schema: { type: integer, minimum: 0, default: 0 }');
  const schema = block(openapi, '    Product:');
  expect(schema).toContain('required: [id, sku, name, unit_price_cents, is_active, available_quantity]');
  expect(schema).toContain('available_quantity: { type: integer, minimum: 0, maximum: 2147483647 }');
  const input = block(openapi, '    ProductInput:');
  expect(input).toContain('unit_price_cents: { type: integer, format: int64, minimum: 0, maximum: 1000000000000 }');
  expectTypeOf<Product>().toEqualTypeOf<{
    id: string; sku: string; name: string; description?: string; image_url?: string;
    unit_price_cents: number; is_active: boolean; available_quantity: number;
  }>();
  expect(method).toContain('name: q');
  expect(method).toContain('At most 200 Unicode code points');
  expect(method).toContain('backslash are literal input, not wildcard syntax.');
  expectTypeOf<ProductPageInput>().toEqualTypeOf<{ limit: number; offset: number; q?: string }>();
});

test('public product detail operation uses a UUID path and Product response with missing-product handling', () => {
  const operation = catalogOperations.getProduct;
  const endpoint = block(openapi, `  ${operation.path}:`);
  const method = block(endpoint, `    ${operation.method.toLowerCase()}:`);
  expect(operation.cookies).toBe(false);
  expect(endpoint).toContain("$ref: '#/components/parameters/Id'");
  expect(method).toContain('security: []');
  expect(method).toContain('operationId: getProduct');
  expect(method).toContain(`        '${operation.status}':`);
  expect(method).toContain("schema: { $ref: '#/components/schemas/Product' }");
  expect(method).toContain("'404': { $ref: '#/components/responses/NotFound' }");
  expect(block(openapi, '    Id:')).toContain('format: uuid');
});
