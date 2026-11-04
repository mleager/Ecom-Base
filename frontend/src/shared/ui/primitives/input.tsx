import type { ComponentProps } from 'react';
import { cn } from '@/shared/ui/utils';

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input
    type={type}
    data-slot="input"
    className={cn(
      'tw:min-h-11 tw:w-full tw:min-w-0 tw:max-w-full tw:rounded-md tw:border tw:border-solid tw:border-input tw:bg-control tw:px-3 tw:py-2 tw:[font:inherit] tw:text-foreground tw:placeholder:text-muted-foreground tw:placeholder:opacity-100 tw:disabled:cursor-not-allowed tw:disabled:bg-muted tw:disabled:text-muted-foreground tw:disabled:opacity-100 tw:aria-invalid:border-destructive',
      className,
    )}
    {...props}
  />;
}

export { Input };
