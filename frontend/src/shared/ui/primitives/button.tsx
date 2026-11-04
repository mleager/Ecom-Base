import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '@/shared/ui/utils';

const buttonVariants = cva(
  'tw:inline-flex tw:min-h-11 tw:min-w-11 tw:max-w-full tw:items-center tw:justify-center tw:gap-2 tw:rounded-md tw:border tw:border-solid tw:[font-family:inherit] tw:text-base tw:leading-normal tw:font-semibold tw:text-center tw:whitespace-normal tw:wrap-anywhere tw:no-underline tw:cursor-pointer tw:disabled:cursor-not-allowed tw:disabled:opacity-100 tw:disabled:bg-muted tw:disabled:text-muted-foreground tw:disabled:border-input tw:[&_svg]:pointer-events-none tw:[&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'tw:border-primary tw:bg-primary tw:text-primary-foreground tw:not-disabled:hover:bg-primary-hover tw:not-disabled:active:bg-primary-active',
        secondary: 'tw:border-input tw:bg-secondary tw:text-secondary-foreground tw:not-disabled:hover:bg-accent tw:not-disabled:active:bg-control-active',
        outline: 'tw:border-input tw:bg-background tw:text-foreground tw:not-disabled:hover:bg-accent tw:not-disabled:active:bg-secondary',
        destructive: 'tw:border-destructive tw:bg-secondary tw:text-destructive tw:not-disabled:hover:bg-accent tw:not-disabled:active:bg-control-active',
        ghost: 'tw:border-transparent tw:bg-transparent tw:text-foreground tw:not-disabled:hover:bg-accent tw:not-disabled:active:bg-secondary',
        link: 'tw:border-transparent tw:bg-transparent tw:text-link tw:underline tw:underline-offset-2',
      },
      size: {
        default: 'tw:px-4 tw:py-2',
        sm: 'tw:px-3 tw:py-2',
        lg: 'tw:min-h-12 tw:px-6 tw:py-3',
        icon: 'tw:size-11 tw:p-2',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({
  className, variant = 'default', size = 'default', asChild = false, type, ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component
    type={asChild ? type : type ?? 'button'}
    data-slot="button"
    data-variant={variant}
    data-size={size}
    className={cn(buttonVariants({ variant, size, className }))}
    {...props}
  />;
}

export { Button, buttonVariants };
