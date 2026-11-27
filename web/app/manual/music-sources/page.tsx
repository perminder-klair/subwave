import MusicSources from '../../../components/manual/MusicSources';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Music Sources',
  description:
    'Where SUB/WAVE gets its music: Navidrome directly, or Jellyfin, Plex and source plugins through the bundled music router — switching, what carries across, and installing plugins.',
  path: '/manual/music-sources',
});

export default function MusicSourcesPage() {
  return <MusicSources />;
}
