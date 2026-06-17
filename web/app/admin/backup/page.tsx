import { redirect } from 'next/navigation';

// Backup moved into Settings → Backup. Redirect old bookmarks/links.
export default function AdminBackupPage() {
  redirect('/admin/settings?section=backup');
}
