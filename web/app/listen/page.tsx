import type { Viewport } from 'next';
import PlayerApp from '@/components/PlayerApp';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Player',
  description:
    'Tune in to the SUB/WAVE broadcast — one live stream, with an AI DJ picking tracks and talking between them. See what is on air right now.',
  path: '/listen',
});

// The player is a fixed, app-shell layout — lock out pinch-zoom so it
// behaves like a native app on mobile. Merges with the root viewport.
export const viewport: Viewport = {
  maximumScale: 1,
  userScalable: false,
};

export default function ListenPage() {
  return <PlayerApp />;
}
