import Observatory from '../../../components/manual/Observatory';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Library Observatory',
  description:
    'The Library Observatory — a full-screen, data-art map of every track the DJ has tagged, placed by genre and lit by energy, with a full dossier for each track.',
  path: '/manual/observatory',
});

export default function ObservatoryManualPage() {
  return <Observatory />;
}
