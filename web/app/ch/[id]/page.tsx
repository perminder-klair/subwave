import type { Viewport } from 'next';
import ChannelPlayer from './ChannelPlayer';
import { pageMeta } from '@/lib/seo';

// Sub-station channel player — the same PlayerApp as /listen, pointed at the
// channel's own API base (/ch/<id>/api) and MP3 mount (/ch/<id>/stream.mp3)
// via a StationOriginProvider. No PlayerPageEffects here: the first-run
// redirect and the audience beacon are install-level concerns owned by / and
// /listen (same rule as the landing showcase embeds).

interface ChannelPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ChannelPageProps) {
  const { id } = await params;
  return pageMeta({
    title: `SUB/WAVE — ${id}`,
    description: `Tune in to the ${id} channel — a parallel always-on stream from this station.`,
    path: `/ch/${id}`,
  });
}

// Render per-request so canonical/og:url pick up the runtime SITE_URL (see
// /listen). The channel id itself is validated by the controller — an unknown
// id just renders a player that reports the stream offline.
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  maximumScale: 1,
  userScalable: false,
};

export default async function ChannelPage({ params }: ChannelPageProps) {
  const { id } = await params;
  return <ChannelPlayer channelId={id} />;
}
