import type { Metadata } from 'next';
import DiscoveryPanel from '../../../components/admin/DiscoveryPanel';

export const metadata: Metadata = { title: 'Discovery Bench' };

export default function AdminDiscoveryPage() {
  return <DiscoveryPanel />;
}
