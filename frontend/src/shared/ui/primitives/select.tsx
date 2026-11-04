import type { ComponentProps } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { cn } from '../utils';
import { Button } from './button';

export const Select = SelectPrimitive.Root;

export function SelectTrigger({ className, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger asChild {...props}>
    <Button variant="outline" className={cn('tw:justify-between tw:tabular-nums', className)}>
      <SelectPrimitive.Value /><SelectPrimitive.Icon aria-hidden="true">⌄</SelectPrimitive.Icon>
    </Button>
  </SelectPrimitive.Trigger>;
}

export function SelectContent({ children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal>
    <SelectPrimitive.Content position="popper" sideOffset={6} data-slot="select-content"
      className="tw:z-60 tw:flex tw:max-h-(--radix-select-content-available-height) tw:min-w-(--radix-select-trigger-width) tw:flex-col tw:overflow-hidden tw:rounded-lg tw:border tw:border-solid tw:border-input tw:bg-popover tw:text-popover-foreground tw:shadow-lg" {...props}>
      <SelectPrimitive.ScrollUpButton className="tw:text-center" aria-hidden="true">↑</SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="tw:min-h-0 tw:p-1">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="tw:text-center" aria-hidden="true">↓</SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>;
}

export function SelectItem({ children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item className="tw:flex tw:min-h-11 tw:cursor-default tw:items-center tw:justify-between tw:gap-2 tw:rounded-md tw:px-3 tw:outline-none tw:data-highlighted:bg-primary tw:data-highlighted:text-primary-foreground" {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator aria-hidden="true">✓</SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}
