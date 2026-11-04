import styles from './checkout.module.css';

export type Scenario = 'accept' | 'reject';

export function PaymentScenario({ value, onChange, disabled, invalid }: {
  value: Scenario | ''; onChange: (value: Scenario) => void; disabled: boolean; invalid: boolean;
}) {
  return <fieldset className={styles.scenarios} disabled={disabled} aria-describedby="simulation-hint">
    <legend>Simulated payment outcome (required)</legend>
    <p id="simulation-hint">Choose an outcome deliberately. No payment provider is contacted and no real charge is made.</p>
    <label><input id="simulation-accept" type="radio" name="payment_scenario" value="accept" checked={value === 'accept'}
      aria-invalid={invalid || undefined} onChange={() => onChange('accept')} />Simulate payment acceptance</label>
    <label><input type="radio" name="payment_scenario" value="reject" checked={value === 'reject'}
      onChange={() => onChange('reject')} />Simulate payment rejection</label>
  </fieldset>;
}
