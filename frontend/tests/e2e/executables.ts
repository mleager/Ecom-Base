import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { removeExecutables } from './teardown';

export type Executable = 'fixtures' | 'api' | 'auth-control';
export interface Executables {
  readonly directory: string;
  readonly buildCount: number;
  get(kind: Executable): Promise<string>;
  retain(): void;
  close(): Promise<void>;
}

// This pool contains code only, never configuration, sessions or database state.
// Its lifetime is one worker in one invocation; native Go owns cross-run caching.
export async function createExecutables(build: (kind: Executable, output: string) => Promise<void>): Promise<Executables> {
  const cache = resolve(import.meta.dirname, '../../../.cache/frontend-e2e');
  await mkdir(cache, { recursive: true });
  const directory = resolve(cache, randomBytes(8).toString('hex'));
  await mkdir(directory, { mode: 0o700 });
  const pending = new Map<Executable, Promise<string>>();
  let retained = false; let closed = false; let count = 0;
  let closing: Promise<void> | undefined;
  return {
    directory, get buildCount() { return count; },
    get(kind) {
      if (closed) return Promise.reject(new Error('Worker executables are already closed.'));
      const existing = pending.get(kind); if (existing) return existing;
      const output = resolve(directory, `${kind}${process.platform === 'win32' ? '.exe' : ''}`);
      count++;
      const result = Promise.resolve().then(() => build(kind, output)).then(() => output);
      pending.set(kind, result);
      return result;
    },
    retain() { retained = true; },
    close() {
      if (closing !== undefined) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled(pending.values());
        if (retained) throw new Error('Worker executables retained after process/database cleanup failure; inspect .cache/frontend-e2e and fixture markers.');
        await removeExecutables(directory);
      })();
      return closing;
    },
  };
}
