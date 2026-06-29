import Voices from '../../../components/manual/Voices';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Voices & TTS',
  description:
    'Voices & TTS for SUB/WAVE — the six text-to-speech engines, the tts-heavy sidecar, the self-hosted Remote engine, voice cloning, and running Chatterbox on a GPU.',
  path: '/manual/voices',
});

export default function VoicesPage() {
  return <Voices />;
}
