import type { ReactNode } from 'react';
import { Notice } from './Notice';
import { Button } from './primitives/button';
import { Card } from './primitives/card';

type AsyncStateProps =
  | { kind: 'loading'; message: string }
  | { kind: 'empty'; message: string; children?: ReactNode }
  | { kind: 'error'; message: string; onRetry?: () => void }
  | { kind: 'ready'; children: ReactNode };

export function AsyncState(props: AsyncStateProps) {
  switch (props.kind) {
    case 'loading':
      return <div role="status" aria-busy="true" className="tw:grid tw:gap-3 tw:py-2">
        {props.message}
        <span data-slot="skeleton" aria-hidden="true" className="tw:h-2 tw:w-full tw:max-w-48 tw:rounded-full tw:bg-muted" />
      </div>;
    case 'empty':
      return <Card asChild className="tw:px-4 tw:py-3"><section role="status" data-state="empty"><p>{props.message}</p>{props.children}</section></Card>;
    case 'error':
      return (
        <Notice tone="error">
          <p>{props.message}</p>
          {props.onRetry && <Button variant="outline" onClick={props.onRetry}>Try again</Button>}
        </Notice>
      );
    case 'ready':
      return props.children;
  }
}
