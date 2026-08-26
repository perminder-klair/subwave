import Concepts from '../../../components/manual/Concepts';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Concepts',
  description:
    'The SUB/WAVE concepts that get asked about most — the persona tone dials, candidate pool vs the agent picker, playlists vs shows, the stem cache, private player vs stream password, dayparts, and what a heart does.',
  path: '/manual/concepts',
});

export default function ConceptsPage() {
  return <Concepts />;
}
