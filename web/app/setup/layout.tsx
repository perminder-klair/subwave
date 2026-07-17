import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import DocShell from '@/components/docs/DocShell';
import { SETUP_PAGES } from '@/components/setup/pages';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Setup',
  description:
    'Run your own SUB/WAVE — connect it to your Navidrome library and an LLM provider (Ollama by default) in about ten minutes.',
};

// Render per-request so canonicals/og:url pick up the runtime SITE_URL — a
// build-time render bakes localhost into image-based installs (see lib/site.ts).
export const dynamic = 'force-dynamic';

export default function SetupLayout({ children }: { children: ReactNode }) {
  return (
    <DocShell pages={SETUP_PAGES} eyebrow="THE SETUP GUIDE" ariaLabel="Setup guide contents">
      {children}
    </DocShell>
  );
}
