import type { ObservationState, ObservationStop } from './OrderObserver';

const messages: Record<ObservationStop, string> = {
  terminal: 'A terminal order state was observed. Automatic observation has stopped.',
  budget: 'Automatic observation reached its time or read limit. A pending order is not a failed payment. Use Check Status for one bounded read.',
  error: 'Automatic observation stopped after an unsuccessful read. Use Check Status for one bounded read; no payment failure is assumed.',
  payment: 'Automatic observation stopped because payment information could not be confirmed. Use Check Status for one bounded read.',
  inactive: 'Automatic observation stopped when this page became inactive. Use Check Status; returning to the page does not restart the loop.',
  interaction: 'Automatic observation stopped for cancellation review. Check Status performs one bounded read.',
  unavailable: 'Automatic observation stopped while the saved order reference was being verified. Check Status performs one bounded read.',
  manual: 'Automatic observation is stopped. Check Status performs one bounded read and does not restart the loop.',
};

export function ObservationStatus({ state }: { state: ObservationState }) {
  return <p className={state.mode === 'automatic' || state.reason !== null && state.reason !== 'terminal' ? 'notice notice-warning' : undefined} role="status" aria-atomic="true">{state.mode === 'automatic'
    ? 'Observing this order automatically: at most 60 seconds or 20 order/payment reads, with 3 seconds between completed observations.'
    : state.reason === null ? '' : messages[state.reason]}</p>;
}
