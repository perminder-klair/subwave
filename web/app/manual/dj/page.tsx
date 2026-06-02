import HowTheDjWorks from '../../../components/manual/HowTheDjWorks';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · How the DJ Works',
  description:
    'How the SUB/WAVE AI DJ works — how it picks the next track, writes its spoken links, and keeps a coherent thread across a session.',
  path: '/manual/dj',
});

export default function HowTheDjWorksPage() {
  return <HowTheDjWorks />;
}
