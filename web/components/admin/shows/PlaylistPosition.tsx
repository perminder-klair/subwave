'use client';

// Play in order: the saved show's position in its running order, and the one
// control that moves it — back to the top. Read through the same controller
// walk the next pick uses (GET /shows/:id/playlist-position), so "next up"
// here is the track that will actually be chosen.

import { Btn } from '../ui';
import type { AdminFetch } from '@/lib/admin-query';
import { usePlaylistPositionQuery, useResetPlaylistPositionMutation } from './queries';

export function PlaylistPosition({ adminFetch, showId, enabled }: {
  adminFetch: AdminFetch;
  showId: string;
  enabled: boolean;
}) {
  const position = usePlaylistPositionQuery(adminFetch, showId, enabled);
  const reset = useResetPlaylistPositionMutation(adminFetch);
  if (!enabled) return null;
  if (position.isPending) return <span className="field-hint">Checking the running order…</span>;
  if (position.isError) return null;
  const data = position.data;
  if (!data?.inOrder) {
    return <span className="field-hint">Save the show to start playing its playlist in order.</span>;
  }
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
      {data.next ? (
        <span>
          Next up: <strong>{data.next.index + 1}</strong> of {data.next.total.toLocaleString()}
          {data.next.title ? <> · {data.next.title}{data.next.artist ? ` by ${data.next.artist}` : ''}</> : null}
        </span>
      ) : (
        <span className="field-hint text-vermilion">
          Nothing to play in order{data.reason ? `: ${data.reason}` : ''}. The DJ picks normally until that changes.
        </span>
      )}
      <Btn
        className="min-h-9 sm:min-h-0"
        onClick={() => reset.mutate(showId)}
        disabled={reset.isPending}
      >
        {reset.isPending ? 'Resetting…' : 'Start from the top'}
      </Btn>
    </div>
  );
}
