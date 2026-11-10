'use client';

import { RefreshCw, Sparkles } from 'lucide-react';
import { Card, Btn, Seg } from '../../ui';
import { num } from '../../LibraryTaggingPanel';
import { RowsTable } from '../RowsTable';
import { useLibrary } from '../LibraryContext';
import { useLikedTracks, useRecentTracks, useUntaggedTracks } from './useTrackModes';
import type { LikedSort, TableVariant, TrackMode } from '../types';
import { PAGE_SIZE } from '../types';

const MODE_TITLE: Record<TrackMode, string> = {
  all: 'Recently added',
  needs: 'Needs tags',
  liked: 'Liked',
};
const MODE_VARIANT: Record<TrackMode, TableVariant> = {
  all: 'recent',
  needs: 'untagged',
  liked: 'liked',
};

export interface TracksTabProps {
  trackMode: TrackMode; setTrackMode: (m: TrackMode) => void;
  // coverage.total - coverage.tagged, or null while coverage is unknown.
  // Labels the Needs-tags toggle and the Card subtitle.
  remaining: number | null;
  // Starts a full tagger run — the "Tag all" quick action.
  onTagAll: () => void;
  taggerRunning: boolean;
  taggerBusy: boolean;
}

export default function TracksTab({
  trackMode, setTrackMode, remaining, onTagAll, taggerRunning, taggerBusy,
}: TracksTabProps) {
  const { likeIndex } = useLibrary();

  // All three run; `enabled` gates the fetch. See useTrackModes.
  const recent = useRecentTracks(trackMode === 'all');
  const untagged = useUntaggedTracks(trackMode === 'needs');
  const liked = useLikedTracks(trackMode === 'liked');

  const rows =
    trackMode === 'needs' ? untagged.rows :
    trackMode === 'liked' ? (liked.rows || []) :
    (recent.rows || []);
  const loading =
    trackMode === 'needs' ? untagged.loading :
    trackMode === 'liked' ? liked.loading :
    recent.loading;

  const sub =
    trackMode === 'liked' ? `${num(liked.total)} liked track${liked.total === 1 ? '' : 's'}`
      : trackMode === 'needs' ? `${untagged.rows.length} loaded${remaining != null ? ` · ${num(remaining)} need tags` : ''}`
      : (recent.rows ? `${recent.rows.length} tracks` : '');

  // Read off the already-fetched index so the mode label stays correct after an
  // optimistic toggle with no extra request.
  const likedCount = Object.keys(likeIndex).length;
  const likedPages = Math.max(1, Math.ceil(liked.total / PAGE_SIZE));

  return (
    <>
      <Card
        title={MODE_TITLE[trackMode]}
        sub={sub}
        right={
          <span className="flex flex-wrap items-center gap-2.5">
            <Seg
              value={trackMode}
              options={[
                { id: 'all', label: 'All' },
                { id: 'needs', label: `Needs tags${remaining != null ? ` · ${num(remaining)}` : ''}` },
                { id: 'liked', label: `Liked${likedCount ? ` · ${num(likedCount)}` : ''}` },
              ]}
              onChange={(v: string) => setTrackMode(v as TrackMode)}
            />
            {trackMode === 'needs' && untagged.rows.length > 0 ? (
              <Btn sm tone="accent" onClick={onTagAll} disabled={taggerRunning || taggerBusy}>
                <Sparkles size={11} /> Tag all
              </Btn>
            ) : trackMode === 'liked' ? (
              <>
                <Seg
                  value={liked.sort}
                  options={[
                    { id: 'recent', label: 'Recent' },
                    { id: 'count', label: 'Most liked' },
                    { id: 'artist', label: 'Artist' },
                  ]}
                  onChange={(v: string) => liked.setSort(v as LikedSort)}
                />
                <Btn sm onClick={liked.reload} disabled={liked.loading}>
                  <RefreshCw size={11} /> {liked.loading ? 'Loading…' : 'Refresh'}
                </Btn>
              </>
            ) : trackMode === 'all' ? (
              <Btn sm onClick={recent.reload} disabled={recent.loading}>
                <RefreshCw size={11} /> {recent.loading ? 'Loading…' : 'Refresh'}
              </Btn>
            ) : null}
          </span>
        }
        bodyClass="!p-0"
      >
        <RowsTable tab={MODE_VARIANT[trackMode]} rows={rows} loading={loading} />
      </Card>

      {trackMode === 'liked' && liked.total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-y-2 text-[11px] text-muted">
          <span className="mono-num">
            {liked.page * PAGE_SIZE + 1}–{Math.min((liked.page + 1) * PAGE_SIZE, liked.total)} of {num(liked.total)}
          </span>
          <span className="flex items-center gap-2">
            <Btn sm disabled={liked.page === 0} onClick={() => liked.setPage(Math.max(0, liked.page - 1))}>‹ prev</Btn>
            <span className="mono-num">page {liked.page + 1} of {likedPages}</span>
            <Btn sm disabled={liked.page + 1 >= likedPages} onClick={() => liked.setPage(liked.page + 1)}>next ›</Btn>
          </span>
        </div>
      )}

      {trackMode === 'needs' && untagged.hasMore && (
        <div className="flex justify-center">
          <Btn onClick={untagged.loadMore} disabled={untagged.loading}>
            {untagged.loading ? 'Loading…' : 'Load more'}
          </Btn>
        </div>
      )}
    </>
  );
}
