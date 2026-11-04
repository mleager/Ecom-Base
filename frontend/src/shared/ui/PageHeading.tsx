import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

export function PageHeading({ title, focusVersion, documentTitle }: { title: string; focusVersion?: number; documentTitle?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { key } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    document.title = documentTitle ?? `${title} | Commerce Lab`;
    heading.current?.focus({ preventScroll: true });
    if (navigationType !== 'POP') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [title, documentTitle, key, navigationType, focusVersion]);

  return <h1 ref={heading} tabIndex={-1}>{title}</h1>;
}
