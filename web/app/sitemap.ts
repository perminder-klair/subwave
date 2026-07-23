import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { getAllNews } from '@/lib/news';

// Served by Next at /sitemap.xml. Public, indexable routes only — the
// admin console (/admin/*), /onboarding, and /observatory are intentionally
// excluded (all noindexed).
const ROUTES = [
  '/',
  '/listen',
  '/landing',
  '/stations',
  '/personas',
  '/shows',
  '/skills',
  '/manual',
  '/manual/getting-started',
  '/manual/requests',
  '/manual/dj',
  '/manual/admin',
  '/manual/shortcuts',
  '/manual/cli',
  '/manual/llm',
  '/manual/voices',
  '/manual/mcp',
  '/manual/clients',
  '/manual/skills',
  '/manual/themes',
  '/manual/analysis',
  '/manual/observatory',
  '/manual/faq',
  '/setup',
  '/setup/prerequisites',
  '/setup/quick-start',
  '/setup/manual',
  '/setup/development',
  '/setup/unraid',
  '/setup/updates',
  '/news',
  '/privacy',
  '/terms',
];

// Rendered per-request so SITE_URL (and the news list) come from the runtime
// container env / filesystem rather than being baked at image-build time —
// the published GHCR image can't know the operator's domain. See robots.ts.
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const news = getAllNews();

  const staticEntries: MetadataRoute.Sitemap = ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: now,
    changeFrequency: route === '/' || route === '/listen' ? 'daily' : 'monthly',
    priority: route === '/' ? 1 : route === '/listen' ? 0.9 : 0.6,
  }));

  // One entry per dispatch, stamped with the article's own date so crawlers
  // see a stable lastModified instead of the request clock. Stays in sync with
  // the markdown in content/news automatically.
  const newsEntries: MetadataRoute.Sitemap = news.map((a) => ({
    url: `${SITE_URL}/news/${a.slug}`,
    lastModified: a.date ? new Date(`${a.date}T00:00:00Z`) : now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  return [...staticEntries, ...newsEntries];
}
