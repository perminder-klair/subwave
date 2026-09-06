'use client';

import { Fragment } from 'react';
import { RefreshCw, ListPlus } from 'lucide-react';
import { Card, Btn } from '../ui';
import { cn } from '../../../lib/cn';
import { num } from '../LibraryTaggingPanel';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { PAGE_SIZE } from './types';
import type { BlockType, LikeIndex, PlayEntry, Track } from './types';
import { Thumb } from './bits';
import { BlockMenu, HeartButton, likeStateFor } from './row-actions';

function playDayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// A play is an air-time snapshot, not a library row, so the thumb and the shared
// row actions get a Track composed from it. `trackId` is null for a track that has
// since left the library: the thumb still gets the words for its letter tile, but
// there is nothing left to heart, block or queue, so those rows render no action
// cluster at all rather than three dead buttons.
function historyTrack(p: PlayEntry): Track {
  return {
    id: p.trackId || '',
    title: p.title || undefined,
    artist: p.artist || undefined,
    album: p.album || undefined,
  };
}

function playSourceLabel(p: PlayEntry): string {
  if (p.source === 'request') return p.requestedBy ? `request · ${p.requestedBy}` : 'request';
  if (p.source === 'ai') return 'DJ pick';
  return 'auto';
}

export function HistoryTab({
  rows, total, page, setPage, loading, queuing, onQueue, onRefresh,
  likeIndex, liking, onToggleLike, blocking, onBlock,
}: {
  rows: PlayEntry[] | null;
  total: number;
  page: number;
  setPage: (fn: (p: number) => number) => void;
  loading: boolean;
  queuing: string | null;
  onQueue: (t: Track) => void;
  onRefresh: () => void;
  // Same actions, same handlers and same optimistic cache as the Browse rows —
  // the heart state comes from the shared index, so a heart set on either tab
  // shows on the other with no refetch (#1600).
  likeIndex: LikeIndex;
  liking: string | null;
  onToggleLike: (t: Track, liked: boolean) => void;
  blocking: string | null;
  onBlock: (t: Track, type: BlockType) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <>
      <Card
        title="Play history"
        sub={rows ? `${num(total)} play${total === 1 ? '' : 's'} on record — every aired track, with how it was picked and what show was on` : ''}
        right={
          <Btn sm onClick={onRefresh} disabled={loading}>
            <RefreshCw size={11} /> {loading ? 'Loading…' : 'Refresh'}
          </Btn>
        }
        bodyClass="!p-0"
      >
        {!rows || rows.length === 0 ? (
          loading || !rows ? (
            <SkeletonRows rows={4} className="m-4" />
          ) : (
            <EmptyState
              compact
              title="Nothing on record yet"
              description="Plays are logged from the moment this version starts airing tracks."
            />
          )
        ) : (
          <div className={cn(loading && 'opacity-60 transition-opacity')}>
            {rows.map((p, i) => {
              const day = playDayLabel(p.playedAt);
              const prev = i > 0 ? rows[i - 1] : null;
              const prevDay = prev ? playDayLabel(prev.playedAt) : null;
              const time = new Date(p.playedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
              const track = historyTrack(p);
              return (
                <Fragment key={p.id}>
                  {day !== prevDay && (
                    <div className="caption border-b border-dashed border-[var(--separator-strong)] px-4 py-1.5 text-muted">{day}</div>
                  )}
                  <div className="flex items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5 last:border-b-0">
                    <span className="mono-num w-11 shrink-0 text-[11px] text-muted" title={new Date(p.playedAt).toLocaleString('en-GB')}>
                      {time}
                    </span>
                    <Thumb track={track} />
                    <div className="min-w-0 flex-1">
                      <div className="lib-title">{p.title || 'unknown'}</div>
                      <div className="lib-artist">{p.artist || ''}{p.album ? ` · ${p.album}` : ''}</div>
                    </div>
                    {p.showName && (
                      <span className="lib-mtag hidden shrink-0 md:inline-block" title="show on air">{p.showName}</span>
                    )}
                    <span className="hidden w-24 shrink-0 text-right text-[11px] text-muted sm:block" title="how it was picked">
                      {playSourceLabel(p)}
                    </span>
                    {p.trackId && (
                      /* Three buttons where there was one, so Queue drops to its icon
                         below sm: — the row still has to leave the title readable on a
                         phone. */
                      <span className="flex shrink-0 items-center gap-1.5">
                        <HeartButton
                          track={track}
                          like={likeStateFor(track, likeIndex)}
                          busy={liking === track.id}
                          onToggle={onToggleLike}
                        />
                        <BlockMenu
                          track={track}
                          busy={blocking === track.id}
                          disabled={!!blocking}
                          onBlock={onBlock}
                        />
                        <Btn
                          sm
                          onClick={() => onQueue(track)}
                          disabled={!!queuing}
                          title="queue this track again"
                        >
                          {queuing === track.id ? '…' : (
                            <><ListPlus size={12} /><span className="hidden sm:inline"> Queue</span></>
                          )}
                        </Btn>
                      </span>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </Card>

      {total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-y-2 text-[11px] text-muted">
          <span className="mono-num">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {num(total)}
          </span>
          <span className="flex items-center gap-2">
            <Btn sm disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</Btn>
            <span className="mono-num">page {page + 1} of {totalPages}</span>
            <Btn sm disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}>next ›</Btn>
          </span>
        </div>
      )}
    </>
  );
}

// ManualTagEditor lives in ManualTagEditor.tsx: operator tags (source='manual') feed
// songsByMood() like the LLM tagger's, and "apply to whole album" targets a whole
// album at once (discussion #336).

