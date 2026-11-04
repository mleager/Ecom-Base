import { basename } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult } from '@playwright/test/reporter';
import { emptyTiming, parseTiming, timingAnnotation, timingFields } from './timing';

// Raw runner errors can include filled passwords, headers or DOM snapshots.
// Keep source locations for debugging without serializing those payloads.
export default class SafeReporter implements Reporter {
  private timing = emptyTiming();
  private measured = 0;
  onBegin(_config: FullConfig, suite: Suite) {
    console.log(`Running ${suite.allTests().length} browser tests.`);
  }

  onTestEnd(test: Pick<TestCase, 'title' | 'location'>, result: Pick<TestResult, 'status' | 'errors'> & Partial<Pick<TestResult, 'annotations'>>) {
    console.log(`${result.status}: ${test.title} (${basename(test.location.file)}:${test.location.line})`);
    if (result.status !== 'passed') {
      for (const error of result.errors) this.onError(error);
    }
    const annotations = result.annotations?.filter((annotation) => annotation.type === timingAnnotation) ?? [];
    const timing = annotations.length === 1 ? parseTiming(annotations[0]?.description) : null;
    if (timing !== null) { this.measured++; for (const field of timingFields) this.timing[field] += timing[field]; }
  }

  onError(error: Pick<TestError, 'message' | 'location'>) {
    console.error('Browser check/setup failed. Inspect the reported source location; raw errors and payloads are omitted.');
    if (error.location) console.error(`Failure at ${basename(error.location.file)}:${error.location.line}`);
    for (const match of error.message?.matchAll(/\bHTTP status ([1-5]\d\d)\b/g) ?? []) {
      console.error(`HTTP status ${match[1]}`);
    }
    for (const id of new Set(error.message?.match(/ecom_fixture_[a-f0-9]{16}/g) ?? [])) {
      console.error(`Inspect owned fixture cleanup: ${id}`);
    }
  }

  onEnd(result: FullResult) {
    console.log(`Browser result: ${result.status}.`);
    console.log(`Browser elapsed: ${Math.round(result.duration)} ms.`);
    if (this.measured > 0) console.log(`Harness timing (${this.measured} tests): ${JSON.stringify(this.timing)}`);
  }

  onStdOut() {}
  onStdErr() {}
}
