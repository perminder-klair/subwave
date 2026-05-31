import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { getNewsSlugs } from '@/lib/news';

// Served by Next at /sitemap.xml. Public, indexable routes only — the
// admin console (/admin/*) is intentionally excluded.
const ROUTES = [
  '/',
  '/listen',
  '/landing',
  '/manual',
  '/manual/getting-started',
  '/manual/requests',
  '/manual/dj',
  '/manual/admin',
  '/manual/shortcuts',
  '/manual/cli',
  '/manual/llm',
  '/manual/mcp',
  '/manual/clients',
  '/manual/faq',
  '/setup',
  '/setup/prerequisites',
  '/setup/quick-start',
  '/setup/manual',
  '/setup/development',
  '/setup/updates',
  '/news',
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  // The news index plus one entry per dispatch — stays in sync with the
  // markdown in content/news automatically.
  const routes = [...ROUTES, ...getNewsSlugs().map((slug) => `/news/${slug}`)];
  return routes.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified,
    changeFrequency: route === '/' || route === '/listen' ? 'daily' : 'monthly',
    priority: route === '/' ? 1 : route === '/listen' ? 0.9 : 0.6,
  }));
}
