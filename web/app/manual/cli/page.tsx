import OperatorCli from '../../../components/manual/OperatorCli';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · The Operator CLI',
  description:
    'The SUB/WAVE operator CLI — install, start, stop, configure, and update your station from a single command-line binary.',
  path: '/manual/cli',
});

export default function OperatorCliPage() {
  return <OperatorCli />;
}
