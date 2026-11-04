// @vitest-environment node
import { expect, test, vi } from 'vitest';
import SafeReporter from '../../tests/e2e/SafeReporter';
import { emptyTiming, parseTiming, timingAnnotation } from '../../tests/e2e/timing';

test('browser reporting retains source locations and cleanup IDs without exposing secrets or raw errors', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const reporter = new SafeReporter();
  reporter.onTestEnd({ title: 'Sign in', location: { file: '/tests/auth.spec.ts', line: 12, column: 1 } }, {
    status: 'failed', errors: [{ message: 'password=private-secret token=private-token ecom_fixture_0123456789abcdef', stack: 'private-stack' }],
  });
  const rendered = [...output.mock.calls, ...errors.mock.calls].flat().join('\n');
  expect(rendered).toContain('auth.spec.ts:12');
  expect(rendered).toContain('ecom_fixture_0123456789abcdef');
  expect(rendered).not.toContain('private-secret');
  expect(rendered).not.toContain('private-token');
  expect(rendered).not.toContain('private-stack');
});

test('timing parser accepts only a bounded numeric allowlist and rejects private or malformed annotations', () => {
  expect(parseTiming(JSON.stringify({ ...emptyTiming(), build_ms: 123, build_commands: 2 }))).toMatchObject({ build_ms: 123, build_commands: 2 });
  for (const value of [undefined, '', 'null', '[]', '{}', JSON.stringify({ ...emptyTiming(), password: 'private-secret' }), JSON.stringify({ ...emptyTiming(), build_ms: 'private-token' }), JSON.stringify({ ...emptyTiming(), cleanup_ms: -1 }), JSON.stringify({ ...emptyTiming(), build_commands: 0.5 }), JSON.stringify({ ...emptyTiming(), startup_ms: 86_400_001 })]) expect(parseTiming(value)).toBeNull();
});

test('reporter aggregates safe timing metadata without rendering other annotations', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {}); const reporter = new SafeReporter();
  const testCase = { title: 'Measured browser journey', location: { file: '/tests/measured.spec.ts', line: 1, column: 1 } };
  reporter.onTestEnd(testCase, { status: 'passed', errors: [], annotations: [{ type: timingAnnotation, description: JSON.stringify({ ...emptyTiming(), build_ms: 12 }) }, { type: 'private', description: 'private-token' }] });
  reporter.onTestEnd(testCase, { status: 'passed', errors: [], annotations: [{ type: timingAnnotation, description: JSON.stringify({ ...emptyTiming(), password: 'private-secret' }) }] });
  reporter.onEnd({ status: 'passed', duration: 100, startTime: new Date() });
  const rendered = output.mock.calls.flat().join('\n'); expect(rendered).toContain('Harness timing (1 tests)'); expect(rendered).toContain('"build_ms":12'); expect(rendered).not.toContain('private-token'); expect(rendered).not.toContain('private-secret');
});
