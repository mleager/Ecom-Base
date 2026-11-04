import { ApiRequestError } from './client';

export async function requestDeadline<T>(signal: AbortSignal, milliseconds: number,
  operation: (signal: AbortSignal, assertBudget: () => void) => Promise<T>,
  failure: () => ApiRequestError = () => new ApiRequestError('cancelled', 'request_cancelled', 'The request ended without a confirmed outcome.')): Promise<T> {
  const cancellation = new AbortController(); const combined = AbortSignal.any([signal, cancellation.signal]);
  const deadline = performance.now() + milliseconds;
  let abort!: () => void;
  const ended = new Promise<never>((_resolve, reject) => {
    abort = () => reject(failure());
    combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort();
  });
  const timer = setTimeout(() => cancellation.abort(), milliseconds);
  const assertBudget = () => {
    if (performance.now() >= deadline) cancellation.abort();
    if (combined.aborted) throw failure();
  };
  try {
    const work = Promise.resolve().then(() => { assertBudget(); return operation(combined, assertBudget); });
    const result = await Promise.race([work, ended]).catch((error: unknown) => { assertBudget(); throw error; }); assertBudget(); return result;
  } finally { clearTimeout(timer); combined.removeEventListener('abort', abort); }
}
