import type { Metadata } from 'next';
import { SITE_URL, OFFICIAL_SITE_URL, IS_OFFICIAL_SITE } from '@/lib/site';

function urlOnBase(base: string, path = '/'): string {
  if (!path || path === '/') return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

// Always emit ABSOLUTE strings: Next pins relative metadata URLs to
// metadataBase, which it drops on force-dynamic routes.
export function absoluteUrl(path = '/'): string {
  return urlOnBase(SITE_URL, path);
}

// Shared pages canonicalise to the official site; station pages use the install origin. Default to
// shared for new documentation pages.
export type PageScope = 'shared' | 'station';

// The URL a page declares as its canonical (and og:url -- crawlers treat a
// mismatched og:url as a competing canonical hint, so they must agree).
export function canonicalUrl(path: string, scope: PageScope = 'shared'): string {
  if (scope === 'shared' && !IS_OFFICIAL_SITE) {
    return urlOnBase(OFFICIAL_SITE_URL, path);
  }
  return absoluteUrl(path);
}

// Next does not deep-merge openGraph, so repeat its fields here. Use absolute titles to bypass the
// layout template and set Twitter fields explicitly.
export function pageMeta({
  title,
  description,
  path,
  type = 'website',
  siteName = 'SUB/WAVE',
  scope = 'shared',
}: {
  title: string;
  description?: string;
  path: string;
  type?: 'website' | 'article';
  siteName?: string;
  scope?: PageScope;
}): Metadata {
  const url = canonicalUrl(path, scope);
  return {
    title: { absolute: title },
    ...(description ? { description } : {}),
    alternates: { canonical: url },
    openGraph: {
      title,
      ...(description ? { description } : {}),
      url,
      siteName,
      type,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      ...(description ? { description } : {}),
    },
  };
}
