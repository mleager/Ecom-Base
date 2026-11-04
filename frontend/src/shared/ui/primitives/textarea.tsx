import type { ComponentProps } from 'react';
import { cn } from '../utils';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(
    'tw:w-full tw:min-w-0 tw:resize-y tw:rounded-md tw:border tw:border-solid tw:border-input tw:bg-control tw:px-3 tw:py-2 tw:[font:inherit] tw:text-foreground tw:aria-invalid:border-destructive',
    className,
  )} {...props} />;
}
