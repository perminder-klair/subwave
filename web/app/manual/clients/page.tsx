import Clients from '../../../components/manual/Clients';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Listen With',
  description:
    'Listen to SUB/WAVE anywhere — browsers, phones, Sonos, car receivers, and any player that speaks Icecast MP3.',
  path: '/manual/clients',
});

export default function ClientsPage() {
  return <Clients />;
}
