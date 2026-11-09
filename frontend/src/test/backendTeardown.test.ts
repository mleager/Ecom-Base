// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createRemovalQueue, removeExecutables, teardownBackend } from '../../tests/e2e/teardown';

const cache = resolve(import.meta.dirname, '../../../.cache/frontend-e2e');
const owned: string[] = [];
async function directory(files: string[] = ['api.exe', 'fixtures.exe', 'auth-control.exe']) {
  const path = resolve(cache, randomBytes(8).toString('hex'));
  await mkdir(path, { recursive: true });
  owned.push(path);
  for (const file of files) await writeFile(resolve(path, file), 'test executable');
  return path;
}
afterEach(async () => {
  for (const path of owned.splice(0)) {
    let files: string[];
    try { files = await readdir(path); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files) await unlink(resolve(path, file));
    await rmdir(path);
  }
});

test('test teardown stops API then removes its database while worker executables remain available', async () => {
  const path = await directory();
  const sibling = await directory();
  let stopped = false;
  await teardownBackend({
    retainExecutables: () => { throw new Error('Successful cleanup must not retain a failed worker.'); },
    stop: async () => { await access(resolve(path, 'api.exe')); stopped = true; },
    removeFixture: async () => {
      expect(stopped).toBe(true);
      await access(resolve(path, 'fixtures.exe'));
    },
  });
  await access(resolve(path, 'fixtures.exe'));
  await removeExecutables(path);
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(resolve(sibling, 'api.exe'))).resolves.toBeUndefined();
});

test('failed fixture removal preserves all binaries for investigation', async () => {
  const path = await directory();
  let retained = false;
  await expect(teardownBackend({
    retainExecutables: () => { retained = true; }, stop: async () => {},
    removeFixture: async () => { throw new Error('Fixture cleanup failed.'); },
  })).rejects.toThrow('Fixture cleanup failed.');
  expect(retained).toBe(true);
  expect((await readdir(path)).sort()).toEqual(['api.exe', 'auth-control.exe', 'fixtures.exe']);
});

test('failed process shutdown still attempts fixture cleanup and preserves binaries', async () => {
  const path = await directory();
  let removed = false;
  let retained = false;
  await expect(teardownBackend({
    retainExecutables: () => { retained = true; }, stop: async () => { throw new Error('API stop failed.'); },
    removeFixture: async () => { removed = true; },
  })).rejects.toThrow('API stop failed.');
  expect(removed).toBe(true);
  expect(retained).toBe(true);
  await expect(access(resolve(path, 'api.exe'))).resolves.toBeUndefined();
});

test.each([{ files: [] }, { files: ['api'] }, { files: ['fixtures.exe', 'api.exe'] }])('early or partial build output is cleaned without a complete binary set', async ({ files }) => {
  const path = await directory(files);
  await removeExecutables(path);
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('unexpected files fail cleanup without deleting binaries or other data', async () => {
  const path = await directory(['api.exe', 'fixtures.exe', 'keep.txt']);
  await expect(removeExecutables(path))
    .rejects.toThrow('Fixture executable cleanup failed');
  expect((await readdir(path)).sort()).toEqual(['api.exe', 'fixtures.exe', 'keep.txt']);
});

test('the cache root cannot be selected as a deletion target', async () => {
  const sibling = await directory();
  await expect(removeExecutables(cache))
    .rejects.toThrow('refused a directory');
  await expect(access(resolve(sibling, 'api.exe'))).resolves.toBeUndefined();
});

test('deferred fixture removals run one at a time in order and drain reports every failure by fixture', async () => {
  const queue = createRemovalQueue();
  const events: string[] = []; let active = 0;
  const removal = (fixture: string, fail = false) => async () => {
    active++; expect(active).toBe(1); events.push(`start ${fixture}`);
    await new Promise((accept) => setTimeout(accept, 5));
    events.push(`end ${fixture}`); active--;
    if (fail) throw new Error('private failure detail');
  };
  queue.schedule('ecom_fixture_000000000000000a', removal('a'));
  queue.schedule('ecom_fixture_000000000000000b', removal('b', true));
  queue.schedule('ecom_fixture_000000000000000c', removal('c'));
  queue.schedule('ecom_fixture_000000000000000d', removal('d', true));
  const drained = queue.drain();
  await expect(drained).rejects.toThrow('Fixture harness cleanup requires inspection for ecom_fixture_000000000000000b, ecom_fixture_000000000000000d.');
  await expect(drained).rejects.not.toThrow('private');
  expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start d', 'end d']);
  expect(() => queue.schedule('ecom_fixture_000000000000000e', removal('e'))).toThrow('already draining');
});

test('an empty or successful removal queue drains cleanly', async () => {
  await expect(createRemovalQueue().drain()).resolves.toBeUndefined();
  const queue = createRemovalQueue(); let removed = false;
  queue.schedule('ecom_fixture_000000000000000a', async () => { removed = true; });
  await queue.drain(); expect(removed).toBe(true);
});
