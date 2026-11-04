import type { ComponentProps, ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../utils';
import { Button } from './button';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ title, description, children, sheet = false, onCloseAutoFocus }: {
  title: string; description: string; children: ReactNode; sheet?: boolean;
  onCloseAutoFocus?: ComponentProps<typeof DialogPrimitive.Content>['onCloseAutoFocus'];
}) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="tw:fixed tw:inset-0 tw:z-40 tw:bg-black/65" />
    <DialogPrimitive.Content onCloseAutoFocus={onCloseAutoFocus} data-slot={sheet ? 'sheet-content' : 'dialog-content'} className={cn(
      'tw:fixed tw:z-50 tw:box-border tw:w-full tw:max-w-sm tw:overflow-y-auto tw:overscroll-contain tw:border tw:border-solid tw:border-input tw:bg-card tw:p-5 tw:text-card-foreground tw:shadow-2xl',
      'tw:inset-y-0 tw:right-0 tw:rounded-l-xl',
      !sheet && 'tw:md:inset-auto tw:md:top-1/2 tw:md:left-1/2 tw:md:max-h-[calc(100dvh-3rem)] tw:md:w-[calc(100%_-_3rem)] tw:md:max-w-3xl tw:md:-translate-x-1/2 tw:md:-translate-y-1/2 tw:md:rounded-xl tw:md:p-7',
    )}>
      <div className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:min-w-0 tw:wrap-anywhere">
          <DialogPrimitive.Title className="tw:m-0 tw:text-xl">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="tw:mt-1 tw:text-sm tw:text-muted-foreground">{description}</DialogPrimitive.Description>
        </div>
        <DialogClose asChild><Button variant="outline" size="sm">Close</Button></DialogClose>
      </div>
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}
