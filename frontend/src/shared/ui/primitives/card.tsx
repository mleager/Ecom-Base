import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '../utils';

export function Card({ asChild = false, className, ...props }: ComponentProps<'div'> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'div';
  return <Component data-slot="card" className={cn(
    'tw:min-w-0 tw:rounded-xl tw:border tw:border-solid tw:border-border tw:bg-card tw:text-card-foreground', className,
  )} {...props} />;
}
