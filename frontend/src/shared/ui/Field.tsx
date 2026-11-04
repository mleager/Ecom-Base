import type { InputHTMLAttributes } from 'react';
import { Input } from './primitives/input';
import styles from './Field.module.css';

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'children'> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ id, label, hint, error, ...input }: FieldProps) {
  const describedBy = [
    input['aria-describedby'],
    hint ? `${id}-hint` : undefined,
    error ? `${id}-error` : undefined,
  ].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}{input.required ? ' (required)' : ''}</label>
      {hint && <p id={`${id}-hint`} className={styles.hint}>{hint}</p>}
      <Input
        {...input}
        id={id}
        aria-invalid={error ? true : input['aria-invalid']}
        aria-describedby={describedBy}
      />
      {error && <p id={`${id}-error`} className={styles.error}>{error}</p>}
    </div>
  );
}
