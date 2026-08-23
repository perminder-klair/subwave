'use client';

import { useState } from 'react';
import { notify, errorMessage } from '../../../../lib/notify';
import { adminJson } from '../../../../lib/admin-query';
import { BlockedTab } from '../BlockedTab';
import { BlockRulesCard } from '../BlockRulesCard';
import { useLibrary } from '../LibraryContext';
import { libraryKeys } from '../queries';
import { useAdminMutation, useAdminQuery } from '../useAdminQuery';
import type { BlockEntry } from '../types';

export default function BlockedTabContainer() {
  const { restampBlockMarks, removeBlockEntry } = useLibrary();
  const [unblocking, setUnblocking] = useState<string | null>(null);

  const blocked = useAdminQuery<BlockEntry[]>({
    key: libraryKeys.blocked(),
    path: '/library/blocklist',
    toastOnError: true,
    parse: raw => (raw as { entries?: BlockEntry[] }).entries || [],
  });

  const unblockEntry = async (e: BlockEntry) => {
    setUnblocking(`${e.type}:${e.id}`);
    try {
      await removeBlockEntry(e);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setUnblocking(null);
    }
  };

  const bulkUnblock = useAdminMutation<number, BlockEntry[]>({
    // One request, not N concurrent DELETEs: the controller rewrites
    // blocklist.json once, so parallel removes could persist a stale snapshot.
    request: async (batch, fetcher) => {
      const j = await adminJson<{ removed?: number }>(fetcher, '/library/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: batch.map(e => ({ type: e.type, id: e.id })) }),
      });
      return j.removed ?? 0;
    },
    onDone: async (removed, _batch, qc) => {
      notify.ok(`${removed} entr${removed === 1 ? 'y' : 'ies'} can play again`);
      // Refetching replaces the hand-rolled filter over local state, and unlike
      // it also picks up anything the server dropped alongside the batch.
      await qc.invalidateQueries({ queryKey: libraryKeys.blocked() });
      await restampBlockMarks();
    },
  });

  return (
    <>
      {/* Attribute rules above the id entries — one "why won't this air"
          surface, two kinds of block. Self-contained; after a rule change only
          the row marks on the other tabs need re-stamping. */}
      <BlockRulesCard onChanged={() => { void restampBlockMarks(); }} />
      <BlockedTab
        entries={blocked.data ?? null}
        loading={blocked.isFetching}
        unblocking={unblocking}
        bulkBusy={bulkUnblock.isPending}
        onUnblock={unblockEntry}
        onBulkUnblock={batch => {
          if (batch.length === 0) return Promise.resolve();
          return bulkUnblock.mutateAsync(batch).then(() => undefined).catch(() => undefined);
        }}
        onRefresh={() => { void blocked.refetch(); }}
      />
    </>
  );
}
