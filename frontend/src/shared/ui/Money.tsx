const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatUSD(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 1_000_000_000_000) {
    throw new Error('Money requires supported nonnegative integer cents.');
  }
  return dollars.format(cents / 100);
}

export function Money({ cents }: { cents: number }) {
  return <span>{formatUSD(cents)}</span>;
}
