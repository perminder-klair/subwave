import type { Metadata } from 'next';
import ConnectPanel from '../../../components/admin/connect/ConnectPanel';

export const metadata: Metadata = {
  title: 'Connect',
};

export default function AdminConnectPage() {
  return <ConnectPanel />;
}
