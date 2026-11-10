import type { MetadataRoute } from 'next';
import { SITE_URL, IS_OFFICIAL_SITE } from '@/lib/site';
import { getAllNews } from '@/lib/news';

// Served by Next at /sitemap.xml. Public, indexable routes only: /admin/*,
// /onboarding and /observatory are deliberately excluded (all noindexed).
const ROUTES = [
  '/',
  '/listen',
  '/landing',
  '/stations',
  '/apps',
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
  '/manual/concepts',
  '/manual/faq',
  '/setup',
  '/setup/prerequisites',
  '/setup/quick-start',
  '/setup/macos',
  '/setup/windows',
  '/setup/linux',
  '/setup/manual',
  '/setup/development',
  '/setup/unraid',
  '/setup/updates',
  '/news',
  '/privacy',
  '/terms',
];

// The subset that is the operator's OWN surface (see PageScope in lib/seo.ts).
// A non-official install's sitemap lists only these: every other route above
// is the shared product site whose canonical points at getsubwave.com there,
// and a sitemap must not advertise URLs that declare themselves non-canonical.
const STATION_ROUTES = new Set(['/', '/listen', '/privacy', '/terms']);

// Rendered per-request so SITE_URL (and the news list) come from the runtime
// container env rather than image-build time: the published GHCR image can't
// know the operator's domain. Same reasoning in robots.ts.
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes = IS_OFFICIAL_SITE ? ROUTES : ROUTES.filter((r) => STATION_ROUTES.has(r));
  // Dispatches are shared content — official sitemap only, same reasoning as
  // STATION_ROUTES above.
  const news = IS_OFFICIAL_SITE ? getAllNews() : [];

  const staticEntries: MetadataRoute.Sitemap = routes.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: now,
    changeFrequency: route === '/' || route === '/listen' ? 'daily' : 'monthly',
    priority: route === '/' ? 1 : route === '/listen' ? 0.9 : 0.6,
  }));

  // Stamped with the article's own date so crawlers see a stable lastModified
  // instead of the request clock.
  const newsEntries: MetadataRoute.Sitemap = news.map((a) => ({
    url: `${SITE_URL}/news/${a.slug}`,
    lastModified: a.date ? new Date(`${a.date}T00:00:00Z`) : now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  return [...staticEntries, ...newsEntries];
}
