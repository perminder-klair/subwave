import Unraid from "@/components/setup/Unraid";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · Unraid',
  description:
    'Run SUB/WAVE on Unraid via the Compose Manager Plus plugin — stack setup, keeping state off the flash, Pull & Up, and the Ollama (local/cloud) AI DJ.',
  path: '/setup/unraid',
});

export default function UnraidSetupPage() {
  return <Unraid />;
}
