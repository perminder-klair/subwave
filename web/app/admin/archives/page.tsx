import { redirect } from 'next/navigation';

// Archives moved into Settings → Archives. Redirect old bookmarks/links.
export default function AdminArchivesPage() {
  redirect('/admin/settings?section=archives');
}
