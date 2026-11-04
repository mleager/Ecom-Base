import { useState } from 'react';
import { Badge } from '../../shared/ui/primitives/badge';
import { cn } from '../../shared/ui/utils';

function imageSource(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function ProductImage({ source, name, detail = false }: { source?: string | undefined; name: string; detail?: boolean }) {
  const url = imageSource(source);
  const [failed, setFailed] = useState<string | null>(null);
  return <div className={cn('tw:aspect-square tw:min-w-0 tw:shrink-0 tw:overflow-hidden tw:bg-secondary',
    detail && 'tw:aspect-[4/3] tw:max-h-128 tw:rounded-xl')}>
    {url !== null && failed !== url ? <img src={url} alt={name} width={320} height={320}
      className="tw:block tw:size-full tw:object-contain"
      loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(url)} />
      : <div className="tw:grid tw:h-full tw:place-items-center tw:p-4 tw:text-center tw:text-muted-foreground" role="img" aria-label={`Image unavailable for ${name}`}>
        <span aria-hidden="true">Image unavailable</span>
      </div>}
  </div>;
}

export function ProductAvailability({ quantity }: { quantity: number }) {
  return <Badge tone={quantity > 0 ? 'success' : 'warning'}>{quantity > 0 ? 'In stock' : 'Out of stock'}</Badge>;
}
