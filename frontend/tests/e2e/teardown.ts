import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const executableCache = resolve(import.meta.dirname, '../../../.cache/frontend-e2e');
const executableNames = new Set(['api', 'fixtures', 'auth-control', 'api.exe', 'fixtures.exe', 'auth-control.exe']);

export async function removeExecutables(directory: string): Promise<void> {
  const target = resolve(directory);
  if (dirname(target) !== executableCache || !/^[a-f0-9]{16}$/.test(basename(target))) {
    throw new Error('Fixture executable cleanup refused a directory outside its owned cache.');
  }
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    const entries = await readdir(target, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || !executableNames.has(entry.name))) throw new Error();
    // Delete only the known executables, then the empty directory. Unexpected
    // files/subdirectories are preserved rather than recursively erased.
    for (const entry of entries) await unlink(resolve(target, entry.name));
    await rmdir(target);
  } catch {
    throw new Error('Fixture executable cleanup failed; inspect .cache/frontend-e2e before retrying.');
  }
}

export async function teardownBackend({ stop, removeFixture, retainExecutables }: {
  stop: () => Promise<void>;
  removeFixture: () => Promise<void>;
  retainExecutables: () => void;
}): Promise<void> {
  try {
    try { await stop(); }
    finally { await removeFixture(); }
  } catch (error) { retainExecutables(); throw error; }
}
