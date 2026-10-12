import type { Metadata } from 'next';
import MusicSourcesPanel from '../../../components/admin/sources/MusicSourcesPanel';

export const metadata: Metadata = {
  title: 'Music sources',
};

export default function AdminMusicSourcesPage() {
  return <MusicSourcesPanel />;
}
