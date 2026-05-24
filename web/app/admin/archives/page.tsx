import type { Metadata } from 'next';
import ArchivesPanel from '../../../components/admin/ArchivesPanel';

export const metadata: Metadata = {
  title: 'Archives',
};

export default function AdminArchivesPage() {
  return <ArchivesPanel />;
}
