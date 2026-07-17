import type { Viewport } from 'next';
import PlayerApp from '@/components/PlayerApp';
import PlayerPageEffects from '@/components/player/PlayerPageEffects';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Player',
  description:
    'Tune in to the SUB/WAVE broadcast — one live stream, with an AI DJ picking tracks and talking between them. See what is on air right now.',
  path: '/listen',
});

// Render per-request so the canonical/og:url pick up the runtime SITE_URL — a
// build-time render bakes localhost into image-based installs (see lib/site.ts).
export const dynamic = 'force-dynamic';

// The player is a fixed, app-shell layout — lock out pinch-zoom so it
// behaves like a native app on mobile. Merges with the root viewport.
export const viewport: Viewport = {
  maximumScale: 1,
  userScalable: false,
};

export default function ListenPage() {
  return (
    <>
      <PlayerPageEffects />
      <PlayerApp />
    </>
  );
}
