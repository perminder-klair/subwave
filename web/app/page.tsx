import type { Metadata, Viewport } from 'next';
import PlayerApp from '@/components/PlayerApp';
import PlayerPageEffects from '@/components/player/PlayerPageEffects';
import Landing from '@/components/Landing';
import { absoluteUrl } from '@/lib/seo';
import { fetchStationIdentity } from '@/lib/station';
import { getShowcaseStations } from '@/lib/stations';

// Read at request time so a deployment can flip player ↔ landing by just
// restarting the web container with a different env value, no rebuild.
export const dynamic = 'force-dynamic';

// The product name — also the default value of the controller's
// `settings.station`, so an un-personalised install reports this verbatim.
const DEFAULT_STATION = 'SUB/WAVE';

// Per-request metadata for the root. The baseline (always emitted) pins the
// canonical + og:url to the absolute origin — the Metadata API leaves absolute
// strings untouched even though it drops metadataBase on this force-dynamic
// route. Title/description/social otherwise inherit from the root layout.
//
// When the homepage is the player (not the landing broadsheet), we personalise
// the share-card preview with the operator's station name + DJ tagline read
// live from the controller (issue #272). On landing mode, a missing/default
// station, or any controller failure we fall through to the generic SUB/WAVE
// branding so the preview never breaks.
export async function generateMetadata(): Promise<Metadata> {
  const base: Metadata = {
    alternates: { canonical: absoluteUrl('/') },
    openGraph: { url: absoluteUrl('/') },
  };

  const mode = (process.env.SUBWAVE_HOMEPAGE || 'player').toLowerCase();
  if (mode !== 'player') return base;

  const id = await fetchStationIdentity();
  const station = id?.station?.trim() || '';
  const tagline = id?.tagline?.trim() || '';

  // Nothing to personalise: no station (or still the default product name) and
  // no tagline → behave exactly as an un-personalised install does today.
  if ((!station || station === DEFAULT_STATION) && !tagline) return base;

  const name = station || DEFAULT_STATION;
  const description =
    tagline ||
    `Tune in to ${name} — one live stream, with an AI DJ picking tracks and talking between them.`;

  // openGraph/twitter are NOT deep-merged across the layout→page chain (see
  // lib/seo.ts pageMeta), so restate them fully here. The layout's hand-written
  // og:image/twitter:image <meta> tags are emitted independently and remain.
  return {
    title: name,
    description,
    alternates: { canonical: absoluteUrl('/') },
    openGraph: {
      title: name,
      description,
      siteName: name,
      url: absoluteUrl('/'),
      type: 'website',
    },
    twitter: { title: name, description },
  };
}

// Fixed app-shell layouts (both player and landing) — lock out pinch-zoom
// so they behave like a native app on mobile. Merges with the root viewport.
export const viewport: Viewport = {
  maximumScale: 1,
  userScalable: false,
};

export default function HomePage() {
  const mode = (process.env.SUBWAVE_HOMEPAGE || 'player').toLowerCase();
  return mode === 'landing' ? (
    <Landing stations={getShowcaseStations()} />
  ) : (
    <>
      <PlayerPageEffects />
      <PlayerApp />
    </>
  );
}
