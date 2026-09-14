'use client';

// One table serves every listing variant (recent, browse, search, untagged, liked);
// `variant` decides which columns and actions are offered.

import { Fragment, useRef, useState } from 'react';
import { RotateCcw, Sparkles, ListPlus, X, Pencil, Ban, Tags, MoreVertical, Undo2, Heart, HeartOff } from 'lucide-react';
import { Btn } from '../ui';
import { cn } from '../../../lib/cn';
 
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import type { BlockRef, BlockType, LikeIndex, QueueBlockKind, TableVariant, Track } from './types';
import {
  CHECK_HIT,
  EnergyMeter,
  MENU_ITEM,
  MENU_PANEL,
  Thumb,
  blockedByLabel,
  fmtDuration,
  unblockLabel,
  useDismissOnOutside,
} from './bits';
import { BlockMenu, HeartButton, QueueMenu, likeStateFor } from './row-actions';
import { ManualTagEditor } from './ManualTagEditor';

interface TrackTableProps {
  tab: TableVariant;
  rows: Track[];
  loading: boolean;
  queuing: string | null;
  retagging: string | null;
  flashId: string | null;
  onQueue: (t: Track) => void;
  onQueueBlock: (t: Track, kind: QueueBlockKind) => void;
  onRetag: (t: Track) => void;
  blocking: string | null;
  onBlock: (t: Track, type: BlockType) => void;
  onUnblock: (t: Track, ref: BlockRef) => void;
  vocab: string[];
  editingId: string | null;
  manualBusy: string | null;
  eraBusy: string | null;
  onEdit: (t: Track) => void;
  onSaveManual: (t: Track, moods: string[], energy: string | null, applyToAlbum: boolean) => void;
  onSaveEraYear: (t: Track, originalYear: number | null, applyToAlbum: boolean) => void;
  onCancelEdit: () => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: (rows: Track[]) => void;
  // Likes (#1253). `onClearLikes` (DELETE /likes/song/:id) prunes LISTENER likes,
  // which the heart never does.
  likeIndex: LikeIndex;
  liking: string | null;
  onToggleLike: (t: Track, liked: boolean) => void;
  onClearLikes: (t: Track) => void;
}

export function TrackTable(p: TrackTableProps) {
  if (p.loading && p.rows.length === 0) {
    return <SkeletonRows rows={6} />;
  }
  if (p.rows.length === 0) {
    return (
      <>
        {p.tab === 'browse' && (
          <EmptyState compact title="No tracks match" description="Try clearing some filters." />
        )}
        {p.tab === 'search' && (
          <EmptyState compact title="Search your library" description="Find a track to queue on demand." />
        )}
        {p.tab === 'untagged' && (
          <EmptyState compact title="Everything's tagged" description="Nice — the whole library has moods." />
        )}
        {p.tab === 'liked' && (
          <EmptyState
            compact
            title="No likes yet"
            description="The heart on the player feeds this, and you can heart tracks here yourself."
          />
        )}
        {p.tab === 'recent' && <EmptyState compact title="Nothing here yet" />}
      </>
    );
  }

  const allSelected = p.rows.length > 0 && p.rows.every(t => p.selected.has(t.id));

  return (
    // Dim, don't blank, stale rows during a refetch so filter changes read as updating.
    <div className={cn(p.loading && 'opacity-60 transition-opacity')}>
      {/* Below sm: the 5-column grid leaves the title ~60px, so rows lay out as
          a plain flex line. `!` beats `.admin-root .lib-colhead/.lib-row`. */}
      <div className="lib-colhead !flex sm:!grid">
        <span>
          <label className={CHECK_HIT}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => p.onToggleAll(p.rows)}
              aria-label={allSelected ? 'deselect all tracks' : 'select all tracks'}
            />
          </label>
        </span>
        <span className="hidden sm:block" />
        <span className="flex-1">title</span>
        <span className="h-tags">mood · energy</span>
        <span className="hidden sm:block" />
      </div>
      {p.rows.map(t => {
        const tagged = !!(t.moods && t.moods.length > 0);
        const editing = p.editingId === t.id;
        const dur = fmtDuration(t.duration);
        const like = likeStateFor(t, p.likeIndex);
        return (
          <Fragment key={t.id}>
          <div className={cn('lib-row !flex sm:!grid', p.flashId === t.id && 'flash')}>
            <label className={CHECK_HIT}>
              <input
                type="checkbox"
                checked={p.selected.has(t.id)}
                onChange={() => p.onToggleSelect(t.id)}
                aria-label={`select ${t.title || 'track'}`}
              />
            </label>
            <Thumb track={t} />
            {/* flex-1 drives the phone layout; grid items ignore flex-*. */}
            <div className="min-w-0 flex-1">
              {/* Badge sits with the TITLE: .lib-tags is display:none below
                  860px and this marker must survive a phone. */}
              <div className="flex min-w-0 items-center gap-2">
                <div className="lib-title">{t.title || '—'}</div>
                {t.blockedBy && (
                  <span className="lib-btag shrink-0" title={`blocked via ${blockedByLabel(t.blockedBy)}`}>
                    <Ban size={10} aria-hidden />
                    {/* Scope word drops below sm:. The full scope stays in the
                        row menu. */}
                    <span aria-hidden>
                      never play
                      {t.blockedBy.kind === 'rule' ? (
                        <span className="hidden sm:inline"> · rule</span>
                      ) : t.blockedBy.type !== 'track' && (
                        <span className="hidden sm:inline"> · {t.blockedBy.type}</span>
                      )}
                    </span>
                    <span className="sr-only">never play — blocked via {blockedByLabel(t.blockedBy)}</span>
                  </span>
                )}
              </div>
              <div className="lib-artist">{t.artist || '—'}{t.year ? ` · ${t.year}` : ''}{dur ? ` · ${dur}` : ''}</div>
              {t.album && <div className="lib-album">{t.album}</div>}
            </div>
            <div className="lib-tags">
              {tagged ? (
                <>
                  {t.moods!.slice(0, 2).map(m => <span key={m} className="lib-mtag">{m}</span>)}
                  {t.energy && <span className="lib-mtag"><EnergyMeter level={t.energy} />{t.energy}</span>}
                  {t.source === 'manual' && <span className="lib-mtag" title="hand-tagged by an operator">manual</span>}
                </>
              ) : (
                <span className="lib-needs" title="needs tags — tag it so the DJ can pick it" aria-label="needs tags">
                  <Tags size={12} />
                </span>
              )}
              {t.bpm != null && <span className="lib-mtag lib-atag" title="tempo">{Math.round(t.bpm)} BPM</span>}
              {t.musicalKey && <span className="lib-mtag lib-atag" title="musical key">{t.musicalKey}</span>}
              {t.loudnessLufs != null && <span className="lib-mtag lib-atag" title="integrated loudness (LUFS)">{t.loudnessLufs.toFixed(1)} LUFS</span>}
              {t.instrumental === true && <span className="lib-mtag lib-atag" title="no vocals detected">instrumental</span>}
              {t.similarity != null && <span className="lib-mtag lib-atag" title="sound match vs your description">≈ {Math.round(t.similarity * 100)}%</span>}
            </div>
            {/* Four 36px buttons cost more than the title is worth on a phone,
                so below sm: they collapse into the overflow menu. */}
            <div className="flex items-center justify-end gap-1.5">
              <RowActionsMenu
                track={t}
                tagged={tagged}
                editing={editing}
                queuing={p.queuing === t.id}
                retagging={p.retagging === t.id}
                blocking={p.blocking === t.id}
                disabled={!!p.queuing || !!p.retagging || !!p.manualBusy || !!p.blocking}
                onQueue={p.onQueue}
                onQueueBlock={p.onQueueBlock}
                onEdit={p.onEdit}
                onRetag={p.onRetag}
                onBlock={p.onBlock}
                onUnblock={p.onUnblock}
                like={like}
                liking={p.liking === t.id}
                onToggleLike={p.onToggleLike}
                onClearLikes={p.onClearLikes}
              />
              <HeartButton
                className="hidden sm:inline-flex"
                track={t}
                like={like}
                busy={p.liking === t.id}
                onToggle={p.onToggleLike}
              />
              <QueueMenu
                className="hidden sm:block"
                track={t}
                busy={p.queuing === t.id}
                disabled={!!p.queuing}
                onQueue={p.onQueue}
                onQueueBlock={p.onQueueBlock}
              />
              <Btn
                sm
                className="hidden sm:inline-flex"
                tone={editing ? 'accent' : undefined}
                onClick={() => p.onEdit(t)}
                disabled={!!p.manualBusy}
                title="Edit moods manually"
              >
                {editing ? <X size={12} /> : <Pencil size={12} />}
              </Btn>
              {/* Offered on every tab: an untagged row can be tagged on the spot. */}
              <Btn
                sm
                className="hidden sm:inline-flex"
                tone={p.tab === 'untagged' || !tagged ? 'accent' : 'solid'}
                onClick={() => p.onRetag(t)}
                disabled={!!p.retagging}
                title={tagged ? 'Retag with AI' : 'Tag with AI'}
              >
                {p.retagging === t.id ? '…' : tagged
                  ? <RotateCcw size={11} />
                  : <Sparkles size={11} />}
              </Btn>
              {/* An entry-blocked row offers the reverse, not another scope: one
                  click lifts the entry that matched. A RULE-blocked row keeps the
                  block menu, since lifting a rule lives on the Blocked tab. */}
              {t.blockedBy && t.blockedBy.kind !== 'rule' ? (
                <Btn
                  sm
                  tone="accent"
                  className="hidden sm:inline-flex"
                  onClick={() => p.onUnblock(t, t.blockedBy!)}
                  disabled={!!p.blocking}
                  title={unblockLabel(t.blockedBy)}
                >
                  {p.blocking === t.id ? '…' : <Undo2 size={12} />}
                </Btn>
              ) : (
                <BlockMenu
                  className="hidden sm:block"
                  track={t}
                  busy={p.blocking === t.id}
                  disabled={!!p.blocking}
                  onBlock={p.onBlock}
                />
              )}
            </div>
          </div>
          {editing && (
            <ManualTagEditor
              track={t}
              vocab={p.vocab}
              busy={p.manualBusy === t.id}
              eraBusy={p.eraBusy === t.id}
              onSave={(moods, energy, applyToAlbum) => p.onSaveManual(t, moods, energy, applyToAlbum)}
              onSaveEraYear={(originalYear, applyToAlbum) => p.onSaveEraYear(t, originalYear, applyToAlbum)}
              onCancel={p.onCancelEdit}
            />
          )}
          </Fragment>
        );
      })}
    </div>
  );
}

export function RowActionsMenu({
  track, tagged, editing, queuing, retagging, blocking, disabled, onQueue, onQueueBlock, onEdit, onRetag, onBlock, onUnblock,
  like, liking, onToggleLike, onClearLikes,
}: {
  track: Track;
  tagged: boolean;
  editing: boolean;
  queuing: boolean;
  retagging: boolean;
  blocking: boolean;
  disabled: boolean;
  onQueue: (t: Track) => void;
  onQueueBlock: (t: Track, kind: QueueBlockKind) => void;
  onEdit: (t: Track) => void;
  onRetag: (t: Track) => void;
  onBlock: (t: Track, type: BlockType) => void;
  onUnblock: (t: Track, ref: BlockRef) => void;
  like: { liked: boolean; count: number };
  liking: boolean;
  onToggleLike: (t: Track, liked: boolean) => void;
  onClearLikes: (t: Track) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const run = (fn: () => void) => { setOpen(false); fn(); };
  useDismissOnOutside(open, () => setOpen(false), rootRef, triggerRef);
  const busy = queuing || retagging || blocking || liking;

  return (
    <div ref={rootRef} className="relative sm:hidden">
      <Btn
        ref={triggerRef}
        sm
        // 36px square: on a phone this is the whole cluster's tap target.
        className="size-9"
        onClick={() => setOpen(o => !o)}
        aria-label={`actions for ${track.title || 'track'}`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {busy ? '…' : <MoreVertical size={15} />}
      </Btn>
      {open && (
        <div className={MENU_PANEL}>
          <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onQueue(track))}>
            <ListPlus size={13} /> Queue on air
          </button>
          {track.album && (
            <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onQueueBlock(track, 'album'))}>
              <ListPlus size={13} /> Queue the whole album
            </button>
          )}
          {track.artist && (
            <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onQueueBlock(track, 'artist'))}>
              <ListPlus size={13} /> Queue a set by this artist
            </button>
          )}
          <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onEdit(track))}>
            {editing ? <X size={13} /> : <Pencil size={13} />} {editing ? 'Close mood editor' : 'Edit moods'}
          </button>
          <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onRetag(track))}>
            {tagged ? <RotateCcw size={13} /> : <Sparkles size={13} />} {tagged ? 'Retag with AI' : 'Tag with AI'}
          </button>
          <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onToggleLike(track, like.liked))}>
            <Heart size={13} className={cn(like.liked && 'fill-vermilion text-vermilion')} />
            {like.liked ? 'Unlike this track' : 'Like this track'}
          </button>
          {like.count > 0 && (
            <button type="button" className={cn(MENU_ITEM, 'items-start')} disabled={disabled} onClick={() => run(() => onClearLikes(track))}>
              <HeartOff size={13} className="mt-px flex-none" />
              <span>
                Clear all likes ({like.count})
                <span className="block text-[10px] text-muted">drops listener likes too — un-hearting only removes yours</span>
              </span>
            </button>
          )}
          <span className="my-1 block border-t border-dashed border-separator-strong" />
          {track.blockedBy?.kind === 'rule' && (
            /* Informational, not actionable: the rule may block hundreds of
               rows, so lifting it happens on the Blocked tab. */
            <span className={cn(MENU_ITEM, 'cursor-default items-start text-muted')}>
              <Ban size={13} className="mt-px flex-none" />
              <span>
                Blocked via {blockedByLabel(track.blockedBy)}
                <span className="block text-[10px]">manage rules on the Blocked tab</span>
              </span>
            </span>
          )}
          {track.blockedBy && track.blockedBy.kind !== 'rule' ? (
            <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onUnblock(track, track.blockedBy!))}>
              <Undo2 size={13} /> {unblockLabel(track.blockedBy)}
            </button>
          ) : (
            <>
              <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onBlock(track, 'track'))}>
                <Ban size={13} /> Never play this track
              </button>
              {track.album && (
                <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onBlock(track, 'album'))}>
                  <Ban size={13} /> Never play this album
                </button>
              )}
              {track.artist && (
                <button type="button" className={cn(MENU_ITEM, 'items-start')} disabled={disabled} onClick={() => run(() => onBlock(track, 'artist'))}>
                  <Ban size={13} className="mt-px flex-none" />
                  <span>
                    Never play this artist
                    <span className="block text-[10px] text-muted">also blocks tracks they're only featured on — acts joined by & or , stay separate</span>
                  </span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The blocklist governs AIRING only — blocked tracks still list here in browse/search,
// they just never make it to the queue.

