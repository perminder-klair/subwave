import AdminSettings from '../../../components/manual/AdminSettings';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Manual · Admin & Settings',
  description:
    'The SUB/WAVE admin console — settings, the DJ persona, shows, the music library, and everything an operator can tune.',
  path: '/manual/admin',
});

export default function AdminSettingsPage() {
  return <AdminSettings />;
}
