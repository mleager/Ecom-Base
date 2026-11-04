import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';

export function useWideScreen(query = '(min-width: 1920px)') {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches); update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export function PageTitle({ title, description }: { title: string; description?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  useEffect(() => { ref.current?.focus(); document.title = title + ' — Commerce Lab design preview'; }, [location.pathname, title]);
  return <div className="page-title"><h1 tabIndex={-1} ref={ref}>{title}</h1>{description && <p className="muted">{description}</p>}</div>;
}
