import Shortcuts from '../../../components/manual/Shortcuts';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Keyboard Shortcuts',
  description:
    'Keyboard shortcuts for the SUB/WAVE player — control playback and move around the station without leaving the keyboard.',
  path: '/manual/shortcuts',
});

export default function ShortcutsPage() {
  return <Shortcuts />;
}
