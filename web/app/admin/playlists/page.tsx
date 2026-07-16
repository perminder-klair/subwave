import type { Metadata } from 'next';
import PlaylistBuilderPanel from '../../../components/admin/PlaylistBuilderPanel';

export const metadata: Metadata = { title: 'Playlist Builder' };

export default function AdminPlaylistsPage() {
  return <PlaylistBuilderPanel />;
}
