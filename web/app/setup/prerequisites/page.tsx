import Prerequisites from "@/components/setup/Prerequisites";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · Prerequisites',
  description:
    'What you need before installing SUB/WAVE — a music library (Navidrome, Jellyfin or Plex), Docker, and an LLM provider such as Ollama.',
  path: '/setup/prerequisites',
});

export default function PrerequisitesPage() {
  return <Prerequisites />;
}
