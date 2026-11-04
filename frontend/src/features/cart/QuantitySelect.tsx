import { useEffect, useId, useRef, useState } from 'react';
import { parseQuantity } from '../../shared/cart';
import { Field } from '../../shared/ui/Field';
import { Button } from '../../shared/ui/primitives/button';
import { Dialog, DialogContent } from '../../shared/ui/primitives/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../../shared/ui/primitives/select';

const presets = Array.from({ length: 10 }, (_, index) => String(index + 1));

export function QuantitySelect({ name, quantity, disabled, preserveDraft, replace }: {
  name: string; quantity: number; disabled: boolean; preserveDraft: boolean; replace: (value: number) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const launchCustom = useRef(false);
  const replacingPreset = useRef(false);
  const restoreFocus = useRef(false);
  const [draft, setDraft] = useState<{ original: number; text: string; error: string } | null>(null);
  const activeDraft = (!disabled || preserveDraft) && draft?.original === quantity ? draft : null;
  const id = useId();
  const focusTrigger = () => { trigger.current?.focus(); };
  useEffect(() => {
    if (draft !== null && activeDraft === null) setDraft(null);
    if (!disabled && restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === document.body) trigger.current?.focus();
    }
  }, [activeDraft, disabled, draft]);
  function commit(value: number) {
    if (value === quantity) return;
    restoreFocus.current = true;
    replace(value);
  }

  return <>
    <Select value={String(quantity)} disabled={disabled} onValueChange={(value) => {
      if (disabled) return;
      if (value === 'more') { launchCustom.current = true; return; }
      const requested = parseQuantity(value);
      if (requested !== null && requested !== quantity) {
        replacingPreset.current = true;
        commit(requested);
      }
    }}>
      <SelectTrigger ref={trigger} aria-label={`Quantity for ${name}`} />
      <SelectContent onCloseAutoFocus={(event) => {
        if (replacingPreset.current) {
          replacingPreset.current = false;
          event.preventDefault();
        }
        if (!launchCustom.current) return;
        event.preventDefault();
        launchCustom.current = false;
        if (trigger.current && !trigger.current.disabled) setDraft({ original: quantity, text: String(quantity), error: '' });
      }}>
        {presets.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
        {quantity > 10 && <SelectItem value={String(quantity)}>{quantity}</SelectItem>}
        <SelectItem value="more">More…</SelectItem>
      </SelectContent>
    </Select>
    <Dialog open={activeDraft !== null} onOpenChange={(open) => { if (!open) setDraft(null); }}>
      {activeDraft !== null && <DialogContent title="Custom quantity" description={name} onCloseAutoFocus={(event) => {
        event.preventDefault();
        focusTrigger();
      }}>
        <form className="tw:mt-4 tw:gap-4" onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          const requested = parseQuantity(activeDraft.text);
          if (requested === null) {
            setDraft({ ...activeDraft, error: 'Enter a whole quantity from 1 to 10000.' });
            document.getElementById(id)?.focus();
            return;
          }
          setDraft(null);
          commit(requested);
        }}>
          <Field id={id} label="Quantity" inputMode="numeric" autoFocus value={activeDraft.text} disabled={disabled}
            hint="Enter the total quantity for this item, from 1 to 10,000."
            error={activeDraft.error} onChange={(event) => setDraft({ ...activeDraft, text: event.target.value, error: '' })} />
          <Button type="submit" disabled={disabled} className="tw:justify-self-start">Apply quantity</Button>
        </form>
      </DialogContent>}
    </Dialog>
  </>;
}
