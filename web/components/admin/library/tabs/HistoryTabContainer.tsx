'use client';

import { useState } from 'react';
import { HistoryTab } from '../HistoryTab';
import { useLibrary } from '../LibraryContext';
import { libraryKeys } from '../queries';
import { useAdminQuery } from '../useAdminQuery';
import type { PlayEntry } from '../types';
import { PAGE_SIZE } from '../types';

// Deliberately sits OUTSIDE the ['library','rows'] key family: a PlayEntry is
// not a Track (no blockedBy, no moods) and the air log is immutable, so none of
// the cross-list operations mean anything here. Do not "fix" the omission by
// filing it under rows.
export default function HistoryTabContainer() {
  const {
    queuing, queueTrack, likeIndex, liking, toggleLike, blocking, blockTrack,
  } = useLibrary();
  const [page, setPage] = useState(0);

  const q = useAdminQuery<{ total: number; rows: PlayEntry[] }>({
    key: libraryKeys.history(page),
    path: () => `/library/history?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    toastOnError: true,
    parse: raw => {
      const j = raw as { total?: number; rows?: PlayEntry[] };
      return { total: j.total || 0, rows: j.rows || [] };
    },
  });

  return (
    <HistoryTab
      // null, not [], until the first page lands — HistoryTab tells "loading"
      // from "genuinely empty" by that distinction.
      rows={q.data?.rows ?? null}
      total={q.data?.total ?? 0}
      page={page}
      setPage={setPage}
      loading={q.isFetching}
      queuing={queuing}
      onQueue={queueTrack}
      onRefresh={() => { void q.refetch(); }}
      // Heart and never-play come straight off the provider, so a history row
      // shares the Browse rows' optimistic updates and their one like index.
      likeIndex={likeIndex}
      liking={liking}
      onToggleLike={toggleLike}
      blocking={blocking}
      onBlock={blockTrack}
    />
  );
}
