'use client';

import { TrackTable } from './TrackTable';
import { useLibrary } from './LibraryContext';
import type { TableVariant, Track } from './types';

// TrackTable takes 20 props and every tab passed the same 17 of them — only
// the variant, the rows and the loading flag actually differ. This binds the
// shared 17 to the provider so a tab renders three.
//
// TrackTable itself stays a pure presentational component taking explicit
// props: it is also rendered by surfaces that are not inside a LibraryProvider.
export function RowsTable({ tab, rows, loading }: {
  tab: TableVariant;
  rows: Track[];
  loading: boolean;
}) {
  const {
    queuing, retagging, flashId, blocking, vocab, editingId, manualBusy, eraBusy,
    selected, likeIndex, liking,
    queueTrack, retagTrack, blockTrack, unblockRow,
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
