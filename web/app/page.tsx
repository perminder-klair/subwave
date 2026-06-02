import type { Metadata, Viewport } from 'next';
import PlayerApp from '@/components/PlayerApp';
import Landing from '@/components/Landing';
import { absoluteUrl } from '@/lib/seo';

// Read at request time so a deployment can flip player ↔ landing by just
// restarting the web container with a different env value, no rebuild.
export const dynamic = 'force-dynamic';

// Self-canonical for the root. Title/description/social are inherited from the
// root layout; we only need to pin the canonical + og:url to the absolute
// origin (the Metadata API leaves absolute strings untouched even though it
// drops metadataBase on this force-dynamic route).
export const metadata: Metadata = {
  alternates: { canonical: absoluteUrl('/') },
  openGraph: { url: absoluteUrl('/') },
};

// Fixed app-shell layouts (both player and landing) — lock out pinch-zoom
// so they behave like a native app on mobile. Merges with the root viewport.
export const viewport: Viewport = {
  maximumScale: 1,
  userScalable: false,
};

export default function HomePage() {
  const mode = (process.env.SUBWAVE_HOMEPAGE || 'player').toLowerCase();
  return mode === 'landing' ? <Landing /> : <PlayerApp />;
}
