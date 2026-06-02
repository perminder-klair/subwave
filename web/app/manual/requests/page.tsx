import Requests from '../../../components/manual/Requests';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Making Requests',
  description:
    'How to request a song on SUB/WAVE — what the AI DJ can match, how it weaves your pick into the live broadcast, and the limits.',
  path: '/manual/requests',
});

export default function RequestsPage() {
  return <Requests />;
}
