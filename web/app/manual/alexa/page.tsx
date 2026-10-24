import Alexa from '../../../components/manual/Alexa';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Alexa',
  description:
    'Connect a station-owned Alexa Custom Skill to SUB/WAVE, choose an invocation name, test it in development mode, and troubleshoot stream playback.',
  path: '/manual/alexa',
});

export default function AlexaPage() {
  return <Alexa />;
}
