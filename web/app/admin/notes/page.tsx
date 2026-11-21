import type { Metadata } from 'next';
import NotesPanel from '../../../components/admin/NotesPanel';

export const metadata: Metadata = { title: 'Extended Sleeve Notes' };

export default function AdminNotesPage() {
  return <NotesPanel />;
}
