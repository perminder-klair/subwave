import type { Metadata } from 'next';
import { SITE_URL } from '@/lib/site';

// Absolute URL for a path — used for canonical + Open Graph / Twitter URLs.
// Always emit absolute strings: Next pins *relative* metadata URLs to
// metadataBase, which it drops on force-dynamic routes (see app/layout.tsx),
// so a relative canonical would resolve to a localhost origin. Absolute
// strings are emitted verbatim and survive untouched.
export function absoluteUrl(path = '/'): string {
  if (!path || path === '/') return SITE_URL;
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

// Per-page metadata with a self-referencing canonical and a matching OG url.
// Next does not deep-merge nested objects like `openGraph` across the
// layout→page chain, so we restate siteName/title here rather than relying on
// inheritance from the root layout.
export function pageMeta({
  title,
  description,
  path,
  type = 'website',
}: {
  title: string;
  description?: string;
  path: string;
  type?: 'website' | 'article';
}): Metadata {
  const url = absoluteUrl(path);
  return {
    title,
    ...(description ? { description } : {}),
    alternates: { canonical: url },
    openGraph: {
      title,
      ...(description ? { description } : {}),
      url,
      siteName: 'SUB/WAVE',
      type,
    },
  };
}
