'use client';

import { TrackTable } from './TrackTable';
import { useLibrary } from './LibraryContext';
import type { TableVariant, Track } from './types';

// Binds the provider-derived TrackTable props so a tab passes only variant,
// rows and loading. TrackTable itself stays presentational with explicit
// props: it is also rendered outside a LibraryProvider.
export function RowsTable({ tab, rows, loading }: {
  tab: TableVariant;
  rows: Track[];
  loading: boolean;
}) {
  const {
    queuing, retagging, flashId, blocking, vocab, editingId, manualBusy, eraBusy,
    selected, likeIndex, liking,
    queueTrack, queueBlock, retagTrack, blockTrack, unblockRow,
    onEditTrack, saveManualTag, saveEraYear, cancelEdit,
    toggleSelect, toggleAllRows, toggleLike, clearLikes,
  } = useLibrary();

  return (
    <TrackTable
      tab={tab}
      rows={rows}
      loading={loading}
      queuing={queuing}
      retagging={retagging}
      flashId={flashId}
      onQueue={queueTrack}
      onQueueBlock={queueBlock}
      onRetag={retagTrack}
      blocking={blocking}
      onBlock={blockTrack}
      onUnblock={unblockRow}
      vocab={vocab}
      editingId={editingId}
      manualBusy={manualBusy}
      eraBusy={eraBusy}
      onEdit={onEditTrack}
      onSaveManual={saveManualTag}
      onSaveEraYear={saveEraYear}
      onCancelEdit={cancelEdit}
      selected={selected}
      onToggleSelect={toggleSelect}
      onToggleAll={toggleAllRows}
      likeIndex={likeIndex}
      liking={liking}
      onToggleLike={toggleLike}
      onClearLikes={clearLikes}
    />
  );
}
