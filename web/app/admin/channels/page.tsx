import type { Metadata } from 'next';
import ChannelsPanel from '../../../components/admin/ChannelsPanel';

export const metadata: Metadata = { title: 'Channels' };

export default function AdminChannelsPage() {
  return <ChannelsPanel />;
}
