import { redirect } from 'next/navigation';

// The music router console became the Music source page's diagnostic tabs;
// old bookmarks land on the matching tab.
const TABS = new Set(['channels', 'signal', 'matrix']);

export default async function AdminRouterRedirect({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  redirect(`/admin/music?tab=${tab && TABS.has(tab) ? tab : 'channels'}`);
}
