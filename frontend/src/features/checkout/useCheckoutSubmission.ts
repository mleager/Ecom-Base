import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useStoreCart } from '../cart/CartProvider';
import type { RecoveryController } from './RecoveryController';
import { retireRejectedCheckout, submitCheckout } from './checkoutSubmission';
import type { SubmissionCommand, SubmissionOutcome } from './checkoutSubmission';
import type { CheckoutRecoveryRecord } from './recoveryPersistence';

function outcomeMessage(outcome: SubmissionOutcome): string {
  switch (outcome.kind) {
    case 'known': return '';
    case 'unresolved': case 'retired': return outcome.message;
    case 'rejected': return outcome.rejection.message;
  }
}

export function useCheckoutSubmission(recovery: RecoveryController | null) {
  const { controller: session } = useAuth(); const cart = useStoreCart()?.controller ?? null; const { key } = useLocation();
  const currentScope = useRef({ recovery, key }); currentScope.current = { recovery, key };
  const lifetime = useMemo(() => ({ active: false }), [recovery, key]);
  const running = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ owner: RecoveryController | null; key: string; pending: boolean; outcome: SubmissionOutcome | null; message: string }>(
    { owner: recovery, key, pending: false, outcome: null, message: '' });
  useEffect(() => { lifetime.active = true; return () => { lifetime.active = false; running.current?.abort(); running.current = null; }; }, [lifetime]);
  const visible = state.owner === recovery && state.key === key;
  const invoke = async (command: SubmissionCommand | { retire: true; expected: CheckoutRecoveryRecord }) => {
    if (!lifetime.active || recovery === null || running.current !== null || currentScope.current.recovery !== recovery || currentScope.current.key !== key) return;
    const cancellation = new AbortController(); running.current = cancellation;
    const active = () => lifetime.active && !cancellation.signal.aborted && currentScope.current.recovery === recovery && currentScope.current.key === key
      && document.visibilityState === 'visible' && session.getSnapshot().revision === recovery.revision && session.getSnapshot().user?.id === recovery.userId;
    setState({ owner: recovery, key, pending: true, outcome: null, message: '' });
    try {
      const outcome = 'retire' in command ? await retireRejectedCheckout(recovery, key, command.expected, cancellation.signal)
        : await submitCheckout(session, recovery, key, command, cancellation.signal, cart?.assertWrite);
      if (!active()) return;
      // The transaction/lock has ended and known_order is durable before reads.
      if (outcome.kind === 'known') void cart?.checkoutCommitted(outcome.record.request.cart_version);
      if (outcome.kind === 'rejected') cart?.invalidate();
      setState({ owner: recovery, key, pending: false, outcome, message: outcomeMessage(outcome) });
    } catch {
      if (active()) setState({ owner: recovery, key, pending: false, outcome: null,
        message: 'Checkout did not finish safely. Any saved original intent is retained. Recheck saved checkout before continuing; do not create a replacement key.' });
    } finally {
      if (running.current === cancellation) {
        running.current = null;
        if (currentScope.current.recovery === recovery && currentScope.current.key === key) setState((value) => value.owner === recovery && value.key === key ? { ...value, pending: false } : value);
      }
    }
  };
  return { pending: visible && state.pending, outcome: visible ? state.outcome : null, message: visible ? state.message : '', invoke };
}
