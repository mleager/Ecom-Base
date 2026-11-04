import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test as base, expect } from '@playwright/test';
import { testApiBaseUrl, testApiPort } from './constants';
import { teardownBackend } from './teardown';
import { emptyTiming, measure, timingAnnotation } from './timing';
import { createExecutables } from './executables';
import type { Executable, Executables } from './executables';

const root = resolve(import.meta.dirname, '../../..');
const execute = promisify(execFile);
const fixturePattern = /^ecom_fixture_[a-f0-9]{16}$/;

interface Account {
  id: string;
  email: string;
  password: string;
}

interface PrivateBundle {
  database_url: string;
  jwt_secret_base64: string;
  http_addr: string;
  frontend_origin: string;
  accounts: { customer_one: Account; customer_two: Account; admin: Account };
}

export interface Backend {
  pendingOrder(): Promise<string>;
  checkoutControl(action: 'interrupt' | 'normal' | 'rollback' | 'restore' | 'claim' | 'block-claim'): Promise<void>;
  apiUrl: string;
  accounts: PrivateBundle['accounts'];
  control(action: 'expire-session' | 'deactivate' | 'session-expiry', account: 'customer_one' | 'admin'): Promise<Record<string, unknown>>;
  control(action: 'near-cart-version-limit', account: 'customer_one'): Promise<Record<string, unknown>>;
  control(action: 'demote', account: 'admin'): Promise<Record<string, unknown>>;
  expiredAccessToken(original: string): string;
  proposedEmail(account: keyof PrivateBundle['accounts']): string;
  mail(account: keyof PrivateBundle['accounts'], proposed?: boolean): Promise<{ Subject: string; Body: string }[]>;
  mailControl(action: 'allow-resend' | 'expire-token' | 'mail-fail' | 'mail-restore' | 'allow-change' | 'expire-change' | 'advance-auth-clock' | 'expire-reset', account: keyof PrivateBundle['accounts']): Promise<void>;
}

async function settings(): Promise<Record<string, string>> {
  let contents: string;
  try { contents = await readFile(resolve(root, '.env'), 'utf8'); }
  catch { throw new Error('Fixture harness requires local root .env; use the documented backend setup.'); }
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error('Fixture harness requires literal KEY=value local settings.');
    values[match[1]!] = match[2]!;
  }
  if (values.APP_ENV !== 'local' || !values.POSTGRES_PASSWORD || !values.MIGRATOR_PASSWORD || !values.APP_DB_PASSWORD) {
    throw new Error('Fixture harness requires explicit local PostgreSQL role passwords.');
  }
  return values;
}

async function freePort(): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('Fixture API port 18080 is occupied; no existing API will be reused.')));
    server.listen(testApiPort, '127.0.0.1', () => server.close((error) => error ? reject(new Error('Fixture API port check failed.')) : accept()));
  });
}

async function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const output = await execute(file, args, { cwd: root, env, windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
    return output.stdout;
  } catch (error) {
    // The fixture CLI intentionally emits only safe identifiers/errors. Extract
    // its checkpoint ID for owned cleanup without forwarding arbitrary output.
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    const id = stderr.match(/ecom_fixture_[a-f0-9]{16}/)?.[0];
    throw new Error(`Fixture harness native command failed${id ? ` for ${id}` : ''}.`);
  }
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let count = 0; count < 50; count++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await delay(100);
  }
  child.kill('SIGKILL');
  for (let count = 0; count < 50; count++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await delay(100);
  }
  throw new Error('Fixture harness could not stop its owned API process.');
}

async function ready(): Promise<boolean> {
  return new Promise((accept) => {
    const request = get({ hostname: '127.0.0.1', port: testApiPort, path: '/health/ready', timeout: 1000 }, (response) => {
      response.resume();
      accept(response.statusCode === 200);
    });
    request.once('error', () => accept(false));
    request.once('timeout', () => { request.destroy(); accept(false); });
  });
}

export const test = base.extend<{ backend: Backend; mailEnabled: boolean }, { executables: Executables }>({
  executables: [async ({}, use, workerInfo) => {
    if (workerInfo.config.workers !== 1) throw new Error('The native browser harness requires one worker because API port 18080 is fixed.');
    const env: NodeJS.ProcessEnv = { ...process.env, GOTOOLCHAIN: 'local', GOCACHE: resolve(root, '.cache/go-build') };
    for (const key of Object.keys(env)) if (/^(PG|GOOSE_|MAIL_|SMTP_|ECOM_|DATABASE_URL$|JWT_SECRET)/i.test(key)) delete env[key];
    const pool = await createExecutables(async (kind, output) => {
      switch (kind) {
        case 'fixtures': await run('go', ['build', '-o', output, './backend/cmd/fixtures'], env); return;
        case 'api': await run('go', ['build', '-o', output, './backend/cmd/api'], env); return;
        case 'auth-control': await run('go', ['test', '-c', '-tags=integration', '-o', output, './backend/internal/fixturecmd'], env); return;
      }
    });
    try { await use(pool); } finally { await pool.close(); }
  }, { scope: 'worker', timeout: 240_000 }],
  mailEnabled: [false, { option: true }],
  backend: [async ({ mailEnabled, executables }, use, testInfo) => {
    const timing = emptyTiming();
    const local = await settings();
    await freePort();
    const postgresPort = local.POSTGRES_PORT ?? '5432';
    if (!/^\d+$/.test(postgresPort) || Number(postgresPort) < 1 || Number(postgresPort) > 65535) {
      throw new Error('Fixture harness PostgreSQL port is invalid.');
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(PG|GOOSE_|MAIL_|SMTP_|ECOM_MAIL_)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      GOTOOLCHAIN: 'local', GOCACHE: resolve(root, '.cache/go-build'), APP_ENV: 'local',
      MAIL_MODE: 'disabled',
      HTTP_ADDR: `127.0.0.1:${testApiPort}`, FRONTEND_ORIGIN: 'http://localhost:5173',
      ECOM_TEST_ADMIN_URL: `postgresql://postgres:${encodeURIComponent(local.POSTGRES_PASSWORD!)}@127.0.0.1:${postgresPort}/ecom?sslmode=disable`,
      ECOM_TEST_MIGRATOR_PASSWORD: local.MIGRATOR_PASSWORD,
      ECOM_TEST_APP_PASSWORD: local.APP_DB_PASSWORD,
    });
    let name: string | undefined;
    let child: ChildProcess | undefined;
    let tool: string | undefined;
    const prepare = async (kind: Executable) => {
      const before = executables.buildCount;
      try { return await measure(timing, 'build_ms', () => executables.get(kind)); }
      finally { timing.build_commands += executables.buildCount - before; }
    };
    try {
      tool = await prepare('fixtures');
      const api = await prepare(mailEnabled ? 'auth-control' : 'api');
      const databaseStart = performance.now();
      try {
        const result: unknown = JSON.parse(await run(tool, ['create'], env));
        if (typeof result !== 'object' || result === null || !('fixture' in result)
          || typeof result.fixture !== 'string' || !fixturePattern.test(result.fixture)) {
          throw new Error('Fixture harness received an invalid owned fixture identifier.');
        }
        name = result.fixture;
      } catch (error) {
        const checkpoint = error instanceof Error ? error.message.match(/ecom_fixture_[a-f0-9]{16}/)?.[0] : undefined;
        if (checkpoint) name = checkpoint;
        throw error;
      }
      await run(tool, ['check', name], env);
      const bundle = JSON.parse(await readFile(resolve(root, '.cache/fixtures', name, 'bundle.json'), 'utf8')) as PrivateBundle;
      if (bundle.http_addr !== env.HTTP_ADDR || bundle.frontend_origin !== env.FRONTEND_ORIGIN) {
        throw new Error('Fixture harness API configuration mismatch.');
      }
      timing.database_ms += Math.round(performance.now() - databaseStart);
      const startupStart = performance.now();
      child = spawn(api, mailEnabled ? ['-test.run=^TestBrowserMailAPI$'] : [], {
        cwd: root, windowsHide: true, stdio: mailEnabled ? ['pipe', 'pipe', 'ignore'] : 'ignore',
        env: { ...env, DATABASE_URL: bundle.database_url, JWT_SECRET_BASE64: bundle.jwt_secret_base64,
          ...(mailEnabled ? { ECOM_BROWSER_MAIL_FIXTURE: name } : {}) },
      });
      let commandID = 0;
      const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
      if (mailEnabled && child.stdout) {
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line: string) => {
          if (Buffer.byteLength(line) > 64 * 1024) { child?.kill(); return; }
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            const entry = typeof value.id === 'number' ? pending.get(value.id) : undefined;
            if (!entry) return;
            clearTimeout(entry.timer); pending.delete(value.id as number);
            if (value.ok === true) entry.resolve(value); else entry.reject(new Error('Private mail command failed.'));
          } catch { /* Go test completion metadata is intentionally ignored. */ }
        });
        child.once('exit', () => { lines.close(); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Private mail API exited.')); } pending.clear(); });
      }
      const mailCommand = (action: string, account: keyof PrivateBundle['accounts']): Promise<Record<string, unknown>> => {
        if (!mailEnabled || !child?.stdin) return Promise.reject(new Error('Private mail harness is not enabled.'));
        const id = ++commandID;
        return new Promise((accept, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Private mail command timed out.')); }, 10_000);
          pending.set(id, { resolve: accept, reject, timer });
          child!.stdin!.write(`${JSON.stringify({ id, action, account })}\n`);
        });
      };
      let failed = false;
      child.once('error', () => { failed = true; });
      let available = false;
      for (let count = 0; count < 100; count++) {
        await delay(100);
        if (failed || child.exitCode !== null || child.signalCode !== null) break;
        if (await ready()) { available = true; break; }
      }
      if (!available) throw new Error('Fixture harness owned API did not become ready.');
      timing.startup_ms += Math.round(performance.now() - startupStart);
      const control: Backend['control'] = async (action, account) => {
        const controlTool = await prepare('auth-control');
        const output = await run(controlTool, ['-test.run=^TestBrowserAuthControl$'], {
          ...env, ECOM_BROWSER_CONTROL: JSON.stringify({ fixture: name, action, account }),
        });
        try {
          const result: unknown = JSON.parse(output.split(/\r?\n/)[0]!);
          if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) throw new Error();
          return result as Record<string, unknown>;
        } catch { throw new Error('Browser control returned invalid result metadata.'); }
      };
      const expiredAccessToken = (original: string): string => {
        try {
          const [header, body, signature, extra] = original.split('.');
          if (!header || !body || !signature || extra !== undefined || original.length > 4096) throw new Error();
          const key = Buffer.from(bundle.jwt_secret_base64, 'base64');
          const expected = createHmac('sha256', key).update(`${header}.${body}`).digest();
          const actual = Buffer.from(signature, 'base64url');
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
          const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
          if (!Object.values(bundle.accounts).some((value) => value.id === claims.sub)) throw new Error();
          const now = Math.floor(Date.now() / 1000);
          const expired = Buffer.from(JSON.stringify({ ...claims, iat: now - 1020, nbf: now - 1020, exp: now - 120 })).toString('base64url');
          const signed = createHmac('sha256', key).update(`${header}.${expired}`).digest('base64url');
          return `${header}.${expired}.${signed}`;
        } catch { throw new Error('Only a valid owned fixture access token can be expired.'); }
      };
      const journeyStart = performance.now(); const buildsBeforeJourney = timing.build_ms;
      try { await use({ apiUrl: testApiBaseUrl, accounts: bundle.accounts, control, expiredAccessToken,
        pendingOrder: async () => { const result = await mailCommand('checkout-pending', 'customer_one'); if (typeof result.order_id !== 'string') throw new Error('Pending fixture order unavailable.'); return result.order_id; },
        checkoutControl: async (action) => { await mailCommand(`checkout-${action}`, 'customer_one'); },
        proposedEmail: (account) => `changed-${bundle.accounts[account].id}@example.test`,
        mail: async (account, proposed = false) => {
          const result = await mailCommand(proposed ? 'proposed-mail' : 'mail', account);
          if (!Array.isArray(result.messages) || !result.messages.every((m: unknown) => typeof m === 'object' && m !== null && 'Subject' in m && typeof m.Subject === 'string' && 'Body' in m && typeof m.Body === 'string')) throw new Error('Private mail response rejected.');
          return result.messages as { Subject: string; Body: string }[];
        },
        mailControl: async (action, account) => { await mailCommand(action, account); },
      }); } finally { timing.journey_ms += Math.max(0, Math.round(performance.now() - journeyStart) - (timing.build_ms - buildsBeforeJourney)); }
    } finally {
      try { await measure(timing, 'cleanup_ms', () => teardownBackend({
        retainExecutables: () => executables.retain(),
        stop: async () => {
          if (mailEnabled && child?.stdin && child.exitCode === null) {
            child.stdin.end(`${JSON.stringify({ id: 1, action: 'stop', account: '' })}\n`);
            for (let count = 0; count < 40 && child.exitCode === null; count++) await delay(100);
          }
          await stop(child);
        },
        removeFixture: async () => {
          if (name !== undefined) {
            if (tool === undefined) throw new Error('Owned fixture cleanup executable is unavailable.');
            try { await run(tool, ['remove', name], env); }
            catch { throw new Error(`Fixture harness cleanup requires inspection for ${name}.`); }
          }
        },
      })); } finally { testInfo.annotations.push({ type: timingAnnotation, description: JSON.stringify(timing) }); }
    }
  }, { timeout: 240_000 }],
});

export { expect };
