import ManualInstall from "@/components/setup/ManualInstall";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · Manual Install',
  description:
    'Manually install SUB/WAVE with Docker Compose — for operators who want full control over the stack and reverse proxy.',
  path: '/setup/manual',
});

export default function ManualInstallPage() {
  return <ManualInstall />;
}
