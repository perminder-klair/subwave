import ExtendedSleeveNotes from '@/components/manual/ExtendedSleeveNotes';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Extended Sleeve Notes',
  description:
    'Enable Extended Sleeve Notes, explore music stories and connections in Station Brain, manage background research, and review what the DJ says on air.',
  path: '/manual/sleeve-notes',
});

export default function ExtendedSleeveNotesPage() {
  return <ExtendedSleeveNotes />;
}
