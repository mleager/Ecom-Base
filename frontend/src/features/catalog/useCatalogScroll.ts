import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType, useOutletContext } from 'react-router';

export interface CatalogScrollContext { catalogScroll: Map<string, number> }

// Only public history keys/positions live in the shell; no product/private data
// is cached. Restore only after results provide their scrollable height.
export function useCatalogScroll(ready: boolean) {
  const { catalogScroll } = useOutletContext<CatalogScrollContext>();
  const { key } = useLocation();
  const navigationType = useNavigationType();
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    pending.current = navigationType === 'POP' ? catalogScroll.get(key) ?? null : null;
    const record = () => {
      if (pending.current !== null) return;
      catalogScroll.delete(key);
      catalogScroll.set(key, window.scrollY);
      if (catalogScroll.size > 50) catalogScroll.delete(catalogScroll.keys().next().value!);
    };
    const cancel = () => { pending.current = null; };
    window.addEventListener('scroll', record, { passive: true });
    window.addEventListener('wheel', cancel, { passive: true });
    window.addEventListener('touchstart', cancel, { passive: true });
    window.addEventListener('pointerdown', cancel, { passive: true });
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('scroll', record);
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
      window.removeEventListener('pointerdown', cancel);
      window.removeEventListener('keydown', cancel);
    };
  }, [catalogScroll, key, navigationType]);
  useLayoutEffect(() => {
    if (!ready || pending.current === null) return;
    window.scrollTo({ top: pending.current, left: 0, behavior: 'auto' });
    pending.current = null;
  }, [ready, key]);
}
