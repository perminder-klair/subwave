import Development from "@/components/setup/Development";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · Development',
  description:
    'Develop on SUB/WAVE — run the dev stack locally, hot-reload the controller and web UI, and smoke-test your changes.',
  path: '/setup/development',
});

export default function DevelopmentPage() {
  return <Development />;
}
