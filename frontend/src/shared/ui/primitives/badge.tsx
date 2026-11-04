import type { ComponentProps } from 'react';
import { cn } from '../utils';

const tones = {
  neutral: 'tw:text-muted-foreground',
  success: 'tw:text-success',
  warning: 'tw:text-warning',
};

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof tones }) {
  return <span data-slot="badge" className={cn(
    'tw:inline-flex tw:items-center tw:rounded-full tw:border tw:border-solid tw:border-border tw:bg-secondary tw:px-2.5 tw:py-1 tw:text-xs tw:font-semibold tw:tabular-nums',
    tones[tone], className,
  )} {...props} />;
}
