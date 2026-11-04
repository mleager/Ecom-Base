import type { ComponentProps } from 'react';
import { cn } from '../utils';

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="native-select" className={cn(
    'tw:min-h-11 tw:min-w-0 tw:max-w-full tw:rounded-md tw:border tw:border-solid tw:border-input tw:bg-control tw:px-3 tw:py-2 tw:[font:inherit] tw:text-foreground',
    className,
  )} {...props} />;
}
