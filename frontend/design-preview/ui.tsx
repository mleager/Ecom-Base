import type { ComponentProps, ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as RadioPrimitive from '@radix-ui/react-radio-group';
import { cn } from '@/shared/ui/utils';
import { Button } from '@/shared/ui/primitives/button';

// Preview-owned adaptations of the reviewed shadcn new-york-v4 registry.
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('tw:flex tw:min-w-0 tw:flex-col tw:gap-5 tw:rounded-xl tw:border tw:border-solid tw:border-border tw:bg-card tw:p-6 tw:text-card-foreground', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('tw:grid tw:gap-2', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('tw:min-w-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('tw:mt-auto tw:flex tw:flex-wrap tw:items-center tw:gap-3', className)} {...props} />;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'error' }) {
  return <span data-slot="badge" className={'badge badge--' + tone}>{children}</span>;
}

export function Alert({ title, children, tone = 'info', ...props }: ComponentProps<'div'> & {
  title: string;
  tone?: 'info' | 'success' | 'warning' | 'error';
}) {
  return <div data-slot="alert" className={'alert alert--' + tone} role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'} {...props}>
    <h2 className="alert-title">{title}</h2><div>{children}</div>
  </div>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div data-slot="skeleton" aria-hidden="true" className={cn('tw:rounded-lg tw:bg-muted', className)} />;
}

export function Separator() {
  return <hr data-slot="separator" className="separator" />;
}

export function Modal({ open, onOpenChange, title, description, children, sheet = false, trigger }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  sheet?: boolean;
  trigger?: HTMLElement | null;
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot={sheet ? 'sheet-overlay' : 'dialog-overlay'} className="modal-overlay" />
      <DialogPrimitive.Content data-slot={sheet ? 'sheet-content' : 'dialog-content'}
        className={'modal-content' + (sheet ? ' modal-content--sheet' : '')}
        onCloseAutoFocus={event => {
          if (trigger?.isConnected) { event.preventDefault(); trigger.focus(); }
        }}>
        <div className="modal-heading">
          <div><DialogPrimitive.Title className="modal-title">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="muted">{description}</DialogPrimitive.Description></div>
          <DialogPrimitive.Close asChild><Button variant="secondary" aria-label={'Close ' + title}>Close</Button></DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

export function Select({ label, value, onValueChange, options, disabled = false }: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
    <SelectPrimitive.Trigger data-slot="select-trigger" aria-label={label} className="select-trigger">
      <SelectPrimitive.Value /><SelectPrimitive.Icon aria-hidden="true">⌄</SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content data-slot="select-content" className="select-content" position="popper" sideOffset={6}>
        <SelectPrimitive.ScrollUpButton className="select-scroll" aria-label="Scroll choices up">↑</SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>
          {options.map(option => <SelectPrimitive.Item className="select-item" key={option.value} value={option.value}>
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator aria-hidden="true">✓</SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="select-scroll" aria-label="Scroll choices down">↓</SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>;
}

export function RadioGroup({ label, value, onValueChange, options }: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; description?: string }[];
}) {
  return <RadioPrimitive.Root data-slot="radio-group" aria-label={label} value={value} onValueChange={onValueChange} className="radio-group">
    {options.map(option => <label className={'radio-choice' + (value === option.value ? ' radio-choice--selected' : '')} key={option.value}>
      <RadioPrimitive.Item className="radio-control" value={option.value} aria-label={option.label}>
        <RadioPrimitive.Indicator className="radio-indicator" />
      </RadioPrimitive.Item>
      <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
    </label>)}
  </RadioPrimitive.Root>;
}

export { Button };
