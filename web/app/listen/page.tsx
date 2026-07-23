import type { Metadata, Viewport } from 'next';
import PlayerApp from '@/components/PlayerApp';
import PlayerPageEffects from '@/components/player/PlayerPageEffects';
import { pageMeta } from '@/lib/seo';
import { fetchStationMeta } from '@/lib/station';

// The generic product copy — what an un-personalised install has always shown,
// and the fallback whenever the controller has nothing station-specific to say.
const GENERIC = pageMeta({
  title: 'SUB/WAVE — Player',
  description:
    'Tune in to the SUB/WAVE broadcast — one live stream, with an AI DJ picking tracks and talking between them. See what is on air right now.',
  path: '/listen',
});

// The other player route, so a branded station's link preview is not labelled
// with the software it runs on (issue #1086) — before this it always emitted the
// SUB/WAVE product copy. No persona-tagline fallback: this route never had one,
// and inheriting it would import exactly the on-air drift #1086 is about. So it
// reads the station description or nothing personal at all.
//
// The route is already force-dynamic, so this runs per-request; on any
// controller failure fetchStationMeta() returns null and we serve GENERIC.
export async function generateMetadata(): Promise<Metadata> {
  const meta = await fetchStationMeta();
  if (!meta) return GENERIC;
  return pageMeta({
    title: `${meta.name} — Player`,
    description: meta.description,
    path: '/listen',
    siteName: meta.name,
  });
}

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
