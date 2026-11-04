import { useEffect, useId, useRef } from 'react';

export interface FormIssue {
  message: string;
  fieldId?: string;
}

export function FormErrorSummary({ issues }: { issues: readonly FormIssue[] }) {
  const summary = useRef<HTMLElement>(null);
  const headingId = useId();

  useEffect(() => {
    if (issues.length > 0) summary.current?.focus();
  }, [issues]);

  if (issues.length === 0) return null;

  return (
    <section ref={summary} tabIndex={-1} role="alert" aria-labelledby={headingId} className="notice notice-error">
      <h2 id={headingId}>Please check the form</h2>
      <ul>
        {issues.map((issue, index) => (
          <li key={index}>
            {issue.fieldId ? (
              <a href={`#${issue.fieldId}`} onClick={(event) => {
                event.preventDefault();
                document.getElementById(issue.fieldId ?? '')?.focus();
              }}>{issue.message}</a>
            ) : issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
