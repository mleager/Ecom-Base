// @vitest-environment node
import { access, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { createExecutables } from '../../tests/e2e/executables';
import type { Executables } from '../../tests/e2e/executables';
import { teardownBackend } from '../../tests/e2e/teardown';

const pools: Executables[] = [];
async function pool(build = async (_kind: string, output: string) => { await writeFile(output, 'test executable'); }) { const value = await createExecutables(build); pools.push(value); return value; }
afterEach(async () => {
  for (const value of pools.splice(0)) {
    let files: string[];
    try { files = await readdir(value.directory); }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue; throw error; }
    for (const file of files) await unlink(`${value.directory}/${file}`);
    await rmdir(value.directory);
  }
});
test('concurrent and repeated requests build each immutable executable once within a worker', async () => {
  const build = vi.fn(async (_kind: string, output: string) => { await writeFile(output, 'test executable'); }); const value = await pool(build);
  const [first, second] = await Promise.all([value.get('fixtures'), value.get('fixtures')]); expect(first).toBe(second); await value.get('fixtures');
  await value.get('api'); await value.get('auth-control'); await value.get('auth-control'); expect(build).toHaveBeenCalledTimes(3); expect(value.buildCount).toBe(3);
  await value.close(); await expect(access(value.directory)).rejects.toMatchObject({ code: 'ENOENT' }); await value.close();
  await expect(value.get('fixtures')).rejects.toThrow('already closed');
});
test('independent workers/runs never reuse an old directory or failed build result', async () => {
  const first = await pool(); const second = await pool(); expect(first.directory).not.toBe(second.directory); expect(await first.get('api')).not.toBe(await second.get('api'));
  await first.close(); await expect(access(await second.get('api'))).resolves.toBeUndefined(); await second.close();
});
test('failed partial builds are not silently retried and close removes only known output', async () => {
  const build = vi.fn(async (_kind: string, output: string) => { await writeFile(output, 'partial'); throw new Error('Build failed.'); }); const value = await pool(build);
  await expect(value.get('api')).rejects.toThrow('Build failed'); await expect(value.get('api')).rejects.toThrow('Build failed'); expect(build).toHaveBeenCalledOnce();
  await value.close(); await expect(access(value.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
test('worker close waits for a pending build and rejects new consumers', async () => {
  let release!: () => void; const held = new Promise<void>((done) => { release = done; }); const value = await pool(async (_kind, output) => { await held; await writeFile(output, 'complete'); });
  const pending = value.get('api'); const closing = value.close(); expect(value.close()).toBe(closing); await expect(value.get('fixtures')).rejects.toThrow('already closed'); release(); await pending; await closing; await expect(access(value.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
test.each(['stop', 'database'] as const)('%s cleanup failure makes worker retention sticky across later successful cleanup', async (failure) => {
  const value = await pool(); const executable = await value.get('fixtures');
  await expect(teardownBackend({ stop: async () => { if (failure === 'stop') throw new Error('Stop failed.'); }, removeFixture: async () => { if (failure === 'database') throw new Error('Database failed.'); }, retainExecutables: () => value.retain() })).rejects.toThrow();
  await teardownBackend({ stop: async () => {}, removeFixture: async () => {}, retainExecutables: () => value.retain() });
  await expect(value.close()).rejects.toThrow('retained'); await expect(access(executable)).resolves.toBeUndefined();
  await expect(value.close()).rejects.toThrow('retained');
});
test('unknown files prevent worker cleanup without erasing known binaries', async () => {
  const value = await pool(); const executable = await value.get('fixtures'); await writeFile(`${value.directory}/keep.txt`, 'unrelated');
  await expect(value.close()).rejects.toThrow('cleanup failed'); await expect(access(executable)).resolves.toBeUndefined();
});
