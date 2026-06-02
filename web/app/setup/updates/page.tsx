import Updates from "@/components/setup/Updates";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · Updates & Help',
  description:
    'Keep SUB/WAVE up to date — pull the latest release, rebuild only what changed, and where to get help when stuck.',
  path: '/setup/updates',
});

export default function UpdatesPage() {
  return <Updates />;
}
