import type { Metadata } from 'next';
import ImagingPanel from '../../../components/admin/imaging/ImagingPanel';

export const metadata: Metadata = {
  title: 'Imaging',
};

export default function AdminImagingPage() {
  return <ImagingPanel />;
}
