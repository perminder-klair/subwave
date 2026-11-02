// The /llms.txt index for language models (https://llmstxt.org). The content
// and the link rules live in lib/llms-txt.ts.
import { buildLlmsTxt } from '@/lib/llms-txt';

// Rendered per request so SITE_URL comes from the runtime container env: a
// build-time render bakes the localhost fallback into every image-based install.
// Same reasoning in robots.ts and sitemap.ts.
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: {
      // text/plain rather than text/markdown, so a browser shows it instead of
      // downloading it.
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
