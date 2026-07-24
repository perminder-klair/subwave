import type { Metadata } from 'next';
import StationsPanel from '../../../components/admin/StationsPanel';

export const metadata: Metadata = {
  title: 'Stations',
};

export default function AdminStationsPage() {
  return <StationsPanel />;
}
