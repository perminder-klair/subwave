import type { Metadata, Viewport } from 'next';
import PlayerApp from '@/components/PlayerApp';
import PlayerPageEffects from '@/components/player/PlayerPageEffects';
import { pageMeta } from '@/lib/seo';
import { fetchStationMeta } from '@/lib/station';

// Fallback whenever the controller has nothing station-specific to say.
const GENERIC = pageMeta({
  title: 'SUB/WAVE — Player',
  description:
    'Tune in to the SUB/WAVE broadcast — one live stream, with an AI DJ picking tracks and talking between them. See what is on air right now.',
  path: '/listen',
  // The player is this station's own page — self-canonical on every install.
  scope: 'station',
});

// Use the station description without an on-air persona fallback so link previews stay stable.
// Controller failures use generic metadata.
export async function generateMetadata(): Promise<Metadata> {
  const meta = await fetchStationMeta();
  if (!meta) return GENERIC;
  return pageMeta({
    title: `${meta.name} — Player`,
    description: meta.description,
    path: '/listen',
    siteName: meta.name,
    scope: 'station',
  });
}

// Per-request so canonical/og:url pick up the runtime SITE_URL; a build-time
// render bakes localhost into image-based installs (see lib/site.ts).
export const dynamic = 'force-dynamic';

// Fixed app-shell layout: pinch-zoom is locked out so it behaves like a native
// app on mobile. Merges with the root viewport.
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
