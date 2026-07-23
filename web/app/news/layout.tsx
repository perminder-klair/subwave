import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import NewsShell from '@/components/news/NewsShell';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Dispatches',
  description:
    'News and updates from the SUB/WAVE desk — new features, fixes, and short how-tos for running your own AI radio station.',
};

// Render per-request so canonicals/og:url pick up the runtime SITE_URL — a
// build-time render bakes localhost into image-based installs (see
// lib/site.ts). This also moves the content/news markdown read to request
// time, so the Docker runner stages copy content/ alongside the standalone
// bundle (web/Dockerfile, docker/Dockerfile.aio).
export const dynamic = 'force-dynamic';

export default function NewsLayout({ children }: { children: ReactNode }) {
  return <NewsShell>{children}</NewsShell>;
}
