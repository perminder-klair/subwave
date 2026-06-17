import { redirect } from 'next/navigation';

// Webhooks moved into Settings → Webhooks. Redirect old bookmarks/links.
export default function AdminWebhooksPage() {
  redirect('/admin/settings?section=webhooks');
}
