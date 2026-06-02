import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { getAllNews } from '@/lib/news';

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
  '/manual/skills',
  '/manual/themes',
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
  const buildTime = new Date();
  const news = getAllNews();

  const staticEntries: MetadataRoute.Sitemap = ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: buildTime,
    changeFrequency: route === '/' || route === '/listen' ? 'daily' : 'monthly',
    priority: route === '/' ? 1 : route === '/listen' ? 0.9 : 0.6,
  }));

  // One entry per dispatch, stamped with the article's own date so crawlers
  // see a stable lastModified instead of the build clock. Stays in sync with
  // the markdown in content/news automatically.
  const newsEntries: MetadataRoute.Sitemap = news.map((a) => ({
    url: `${SITE_URL}/news/${a.slug}`,
    lastModified: a.date ? new Date(`${a.date}T00:00:00Z`) : buildTime,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  return [...staticEntries, ...newsEntries];
}
