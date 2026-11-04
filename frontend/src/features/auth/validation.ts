import type { RegisterInput } from '../../shared/api/contracts';
import type { FormIssue } from '../../shared/ui/FormErrorSummary';

function wellFormed(value: string): boolean {
  return !Array.from(value).some((character) => {
    const point = character.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  });
}

export function validPassword(value: string): boolean {
  const length = Array.from(value).length;
  return wellFormed(value) && length >= 15 && length <= 128 && new TextEncoder().encode(value).length <= 512;
}

export function validEmailInput(value: string): boolean {
  const email = value.trim();
  return wellFormed(email) && new TextEncoder().encode(email).length <= 254 && /^[^\s@<>\0]+@[^\s@<>\0]+$/.test(email);
}

export function validateAuth(mode: 'signup' | 'login', values: RegisterInput): FormIssue[] {
  const issues: FormIssue[] = [];
  if (mode === 'signup') {
    for (const [field, label] of [['first_name', 'First name'], ['last_name', 'Last name']] as const) {
      const name = values[field].trim();
      if (!wellFormed(name) || name.includes('\0') || Array.from(name).length < 1 || Array.from(name).length > 200) {
        issues.push({ fieldId: `${mode}-${field}`, message: `${label} must contain 1–200 characters.` });
      }
    }
  }
  if (!validEmailInput(values.email)) {
    issues.push({ fieldId: `${mode}-email`, message: 'Enter a valid email address of at most 254 UTF-8 bytes.' });
  }
  if (!validPassword(values.password)) {
    issues.push({ fieldId: `${mode}-password`, message: 'Password must contain 15–128 characters, at most 512 UTF-8 bytes. Spaces count and are preserved.' });
  }
  return issues;
}
