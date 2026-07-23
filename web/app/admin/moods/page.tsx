import type { Metadata } from 'next';
import MoodsPanel from '../../../components/admin/MoodsPanel';

export const metadata: Metadata = {
  title: 'Moods',
};

export default function AdminMoodsPage() {
  return <MoodsPanel />;
}
