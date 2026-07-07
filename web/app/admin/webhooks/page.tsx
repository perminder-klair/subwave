import { redirect } from 'next/navigation';

// Webhooks live under Connect → Webhooks. Redirect old bookmarks/links.
export default function AdminWebhooksPage() {
  redirect('/admin/connect?tab=webhooks');
}
