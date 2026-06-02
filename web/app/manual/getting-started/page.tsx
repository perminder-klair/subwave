import GettingStarted from '../../../components/manual/GettingStarted';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Getting Started',
  description:
    'Get started with SUB/WAVE — what the station is, how to tune in for the first time, and how to find your way around.',
  path: '/manual/getting-started',
});

export default function GettingStartedPage() {
  return <GettingStarted />;
}
