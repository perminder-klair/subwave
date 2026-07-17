// Public site origin — the single source of truth for absolute URLs in
// metadata, Open Graph / Twitter cards, robots, and the sitemap.
//
// SITE_URL is resolved at RUNTIME: every route that emits an absolute URL
// (robots.txt, sitemap.xml, and each public page's canonical/og:url via
// `export const dynamic = 'force-dynamic'`) renders per-request, so the
// running container's env is what matters. This is deliberate — the published
// GHCR image is one generic build shared by every operator, so the domain
// cannot be known at image-build time; baking it produced localhost URLs on
// every image-based install. Define SITE_URL once in .env
// (docker-compose.yml plumbs it into the web container's environment).
// NEXT_PUBLIC_SITE_URL is accepted as a fallback for older configs. Defaults
// to the dev origin so local builds still produce a valid `metadataBase`
// without Next's warning.
export const SITE_URL = (
  process.env.SITE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  'http://localhost:7700'
).replace(/\/$/, '');
