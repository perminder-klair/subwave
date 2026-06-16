import type { Metadata } from 'next';
import BackupPanel from '../../../components/admin/BackupPanel';

export const metadata: Metadata = {
  title: 'Backup',
};

export default function AdminBackupPage() {
  return <BackupPanel />;
}
