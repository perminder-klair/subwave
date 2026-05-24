import type { Metadata } from 'next';
import WebhooksPanel from '../../../components/admin/WebhooksPanel';

export const metadata: Metadata = {
  title: 'Webhooks',
};

export default function AdminWebhooksPage() {
  return <WebhooksPanel />;
}
