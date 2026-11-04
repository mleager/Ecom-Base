import type { ReactNode } from 'react';

export function Notice({ tone, children }: {
  tone: 'info' | 'success' | 'warning' | 'error';
  children: ReactNode;
}) {
  return (
    <div data-slot="alert" className={`notice notice-${tone} tw:min-w-0 tw:wrap-anywhere`} role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
