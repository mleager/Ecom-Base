// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('focused npm groups cover every browser spec exactly once without narrowing the full command', async () => {
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const files = (await readdir(resolve(root, 'tests/e2e'))).filter((name) => name.endsWith('.spec.ts'));
  const groups = ['admin', 'auth', 'checkout', 'storefront', 'harness']; const memberships = new Map(files.map((file) => [file, 0]));
  for (const group of groups) {
    const command = manifest.scripts[`test:e2e:${group}`]!; expect(command.startsWith('playwright test ')).toBe(true);
    const filters = command.slice('playwright test '.length).split(' '); expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) expect(files.some((file) => new RegExp(filter).test(`/tests/e2e/${file}`))).toBe(true);
    for (const file of files) if (filters.some((filter) => new RegExp(filter).test(`/tests/e2e/${file}`))) memberships.set(file, memberships.get(file)! + 1);
  }
  expect([...memberships].filter(([, count]) => count !== 1)).toEqual([]);
  expect(manifest.scripts['test:e2e']).toBe('playwright test'); expect(manifest.scripts.test).toBe('vitest run');
  expect(manifest.scripts['test:e2e:failed']).toBe('playwright test --last-failed');
});
