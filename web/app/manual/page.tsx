import Overview from '../../components/manual/Overview';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual',
  description:
    'The SUB/WAVE manual — how to tune in, make song requests, understand the AI DJ, and run the station from the admin console.',
  path: '/manual',
});

export default function ManualOverviewPage() {
  return <Overview />;
}
