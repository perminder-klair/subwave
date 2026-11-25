'use client';

// Settings → Music source moved to its own page, Admin → Music source
// (/admin/music), where the source is chosen, tested and switched beside the
// router's diagnostics. The section stays in Settings' list and search, since
// that is where people look for it, and forwards there.

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card } from '../ui';

export const MUSIC_SOURCE_PAGE = '/admin/music?tab=source';

export function MusicSourceSection() {
  const router = useRouter();
  useEffect(() => { router.replace(MUSIC_SOURCE_PAGE); }, [router]);
  return (
    <Card title="Music source" sub="has its own page">
      <div className="text-[13px] text-muted">
        Opening <Link href={MUSIC_SOURCE_PAGE} className="underline">Music source</Link>…
      </div>
    </Card>
  );
}
