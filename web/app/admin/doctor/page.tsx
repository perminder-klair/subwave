import type { Metadata } from 'next';
import DoctorPanel from '../../../components/admin/DoctorPanel';

export const metadata: Metadata = { title: 'DJ Doc' };

export default function AdminDoctorPage() {
  return <DoctorPanel />;
}
