// Resolve SITE_URL at runtime so the shared Docker image uses each install's domain.
// NEXT_PUBLIC_SITE_URL supports older configs.
export const SITE_URL = (
  process.env.SITE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  'http://localhost:7700'
).replace(/\/$/, '');

// The project's own public site. Non-official installs point the canonicals
// of SHARED pages (landing, docs, news, community catalogs) here — see
// lib/seo.ts canonicalUrl().
export const OFFICIAL_SITE_URL = 'https://getsubwave.com';

function isOfficialHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'getsubwave.com' || host === 'www.getsubwave.com';
  } catch {
    return false;
  }
}

// True when this install IS the official site, or SUBWAVE_INDEX_ALL=1.
// Every install serves the same marketing/docs/news pages, so non-official ones
// donate those canonicals back and drop the pages from their sitemap (still
// serving them) rather than competing for the same search cluster.
export const IS_OFFICIAL_SITE =
  process.env.SUBWAVE_INDEX_ALL === '1' || isOfficialHost(SITE_URL);
