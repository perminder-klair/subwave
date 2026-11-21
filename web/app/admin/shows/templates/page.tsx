import type { Metadata } from 'next';
import TemplateShowsPanel from '../../../../components/admin/TemplateShowsPanel';

export const metadata: Metadata = { title: 'Sub/Shows' };

export default function AdminTemplateShowsPage() {
  return <TemplateShowsPanel />;
}
