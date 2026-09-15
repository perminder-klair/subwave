import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import DiscoveryPanel from '../../../components/admin/DiscoveryPanel';

export const metadata: Metadata = { title: 'Discovery Bench' };

export default function AdminDiscoveryPage() {
  if (!/^(1|true|yes|on)$/i.test(process.env.SUBWAVE_DISCOVERY_BENCH || '')) notFound();
  return <DiscoveryPanel />;
}
