import QuickStart from "@/components/setup/QuickStart";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · Quick Start',
  description:
    'Quick start for SUB/WAVE — the one-line installer that scaffolds, configures, and brings your station up in minutes.',
  path: '/setup/quick-start',
});

export default function QuickStartPage() {
  return <QuickStart />;
}
