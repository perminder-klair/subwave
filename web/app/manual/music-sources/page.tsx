import MusicSources from '../../../components/manual/MusicSources';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Music Sources',
  description:
    'SUB/WAVE’s pluggable music library — Navidrome/Subsonic (default), Plex, or a plain local folder. What each source can serve, why the mood tagger and analyzer matter more off Navidrome, and what to know when you switch.',
  path: '/manual/music-sources',
});

export default function MusicSourcesPage() {
  return <MusicSources />;
}
