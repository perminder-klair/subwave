import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// Disallow the client-gated admin shell and API. Render per request so SITE_URL comes from the container runtime.

// Rendered per-request so SITE_URL comes from the runtime container env: a
// build-time render bakes the localhost fallback into every image-based install.
// Same reasoning in sitemap.ts and the public page segments.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/api'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
