import SetupOverview from "@/components/setup/SetupOverview";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup',
  description:
    'Run your own SUB/WAVE — connect a Navidrome library and an LLM provider, and have your station on air in about ten minutes.',
  path: '/setup',
});

export default function SetupPage() {
  return <SetupOverview />;
}
