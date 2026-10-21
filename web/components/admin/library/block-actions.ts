/**
 * The never-play list's track writes and what they do to the Library's caches,
 * shared by the Library page and the Dash's Never play so the two cannot
 * drift: one POST, one DELETE that reads a 404 as "already lifted", one Undo
 * toast, and one reconciliation (the Blocked tab invalidated, the loaded Track
 * lists re-marked rather than refetched).
 *
 * Imports nothing from LibraryContext, which uses it: that would be a cycle.
 */
import type { QueryClient } from '@tanstack/react-query';
import { notify, errorMessage } from '../../../lib/notify';
import { AdminResponseError, adminJson, adminResponse, type AdminFetch } from '../../../lib/admin-query';
import { applyBlockMarks, libraryKeys, rowsOf } from './queries';
import type { BlockEntry, BlockRef, BlockType, Track } from './types';

// Per-call cap on POST /library/blocklist/check, matching the controller's.
// A Search tab paged deep with Load more can hold more rows than that.
const CHECK_CHUNK = 500;

/** POST /library/blocklist. Any non-2xx throws, a 409 "already blocked" included. */
export function postBlock(
  fetcher: AdminFetch,
  type: BlockType,
  trackId: string,
): Promise<{ entry?: BlockEntry; purged?: number }> {
  return adminJson(fetcher, '/library/blocklist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, trackId }),
  });
}

/**
 * DELETE one entry. A 404 means it is already gone (lifted from the Blocked
 * tab, another tab or MCP), which is the outcome the caller asked for.
 */
export async function deleteBlockEntry(
  fetcher: AdminFetch,
  e: { type: BlockType; id: string },
): Promise<void> {
  try {
    await adminResponse(
      fetcher,
      `/library/blocklist/${e.type}/${encodeURIComponent(e.id)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (!(error instanceof AdminResponseError) || error.status !== 404) throw error;
  }
}

// Re-marks the rows already loaded: refetching every tab would lose pagination
// and re-hit Navidrome, and matching client-side would duplicate the
// normalised-name rules in music/blocklist.ts. Rows come from the query cache,
// so this reaches lists a tab switch unmounted but hasn't evicted, and costs
// nothing when none are cached.
export async function restampCachedBlockMarks(qc: QueryClient, fetcher: AdminFetch): Promise<void> {
  const byId = new Map<string, Track>();
  for (const [, data] of qc.getQueriesData({ queryKey: libraryKeys.rows })) {
    for (const t of rowsOf(data)) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  }
  if (byId.size === 0) return;
  const rows = [...byId.values()].map(t => ({ id: t.id, artist: t.artist, album: t.album }));
  try {
    const marks: Record<string, BlockRef | null> = {};
    // Chunked to stay under the endpoint's per-call cap.
    for (let i = 0; i < rows.length; i += CHECK_CHUNK) {
      const j = await adminJson<{ blocked?: Record<string, BlockRef | null> }>(
        fetcher,
        '/library/blocklist/check',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: rows.slice(i, i + CHECK_CHUNK) }),
        },
      );
      Object.assign(marks, j.blocked || {});
    }
    applyBlockMarks(qc, marks);
  } catch {
    // Enrichment, not the operation: the block itself succeeded, so leave the
    // last-known marks rather than toasting.
  }
}

/** After any block write, from whichever page made it. */
export async function reconcileBlockCaches(qc: QueryClient, fetcher: AdminFetch): Promise<void> {
  // The Blocked tab's list is a query like any other, so invalidating reaches
  // it whether or not that tab is mounted.
  void qc.invalidateQueries({ queryKey: libraryKeys.blocked() });
  await restampCachedBlockMarks(qc, fetcher);
}

export function liftedText(e: { id: string; name?: string | null }): string {
  return `“${e.name || e.id}” can play again`;
}

/**
 * The toast for a new entry. Undo runs `lift`, then says so. `'err'` when
 * something after the block failed (the Dash's skip): the entry is still new.
 */
export function notifyBlockedWithUndo(
  text: string,
  entry: BlockEntry,
  lift: (entry: BlockEntry) => Promise<unknown>,
  tone: 'ok' | 'err' = 'ok',
): void {
  notify.undo(text, () => {
    lift(entry)
      .then(() => notify.ok(liftedText(entry)))
      .catch(err => notify.err(errorMessage(err)));
  }, tone);
}
