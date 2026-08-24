'use client';

import {
  createContext, useCallback, useContext, useMemo, useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notify, errorMessage } from '../../../lib/notify';
import type { PlaylistSummary } from './types';
import type { Coverage, TaggerState } from '../LibraryTaggingPanel';
import {
  applyBlockMarks, applyEraYearEvent, applyLikeChange, applyTagEvent, libraryKeys, rowsOf,
} from './queries';
import {
  AdminResponseError,
  adminJson,
  adminResponse,
  useQueryErrorToast,
  type AdminFetch,
} from '../../../lib/admin-query';
import type {
  BlockEntry, BlockRef, BlockType, BrowseResponse, LikeIndex, Track,
} from './types';
import { refreshPlaylistCatalogues } from '../playlist-cache';

// Per-call cap on POST /library/blocklist/check, matching the controller's.
// A Search tab paged deep with Load more can hold more rows than that.
const CHECK_CHUNK = 500;

// Stable fallbacks for the two queries whose absent data has a meaning. A fresh
// literal per render would change the context value's identity every time.
const EMPTY_LIKES: LikeIndex = {};
const EMPTY_PLAYLISTS: PlaylistSummary[] = [];

export interface LibraryShared {
  // Passed down from the page owner so every Library resource shares one
  // feature boundary. useAdminAuth itself observes the module-owned auth store,
  // so a 401 here also tears down the shell provider and its QueryClient.
  adminFetch: AdminFetch;
  ready: boolean;

  // The two page-wide polls. They live here rather than in useTaggerControls
  // because the coverage cadence depends on the tagger snapshot, and both are
  // read outside the Tagging panel (Search gates its mode toggle on coverage) —
  // one owner keeps them from being observed at two different intervals.
  coverage: Coverage | null;
  reloadCoverage: () => Promise<void>;
  tagger: TaggerState | null;

  // Re-stamp blockedBy across every cached list.
  restampBlockMarks: () => Promise<void>;

  likeIndex: LikeIndex;
  liking: string | null;
  toggleLike: (track: Track, isLiked: boolean) => Promise<void>;
  clearLikes: (track: Track) => Promise<void>;

  selected: Set<string>;
  toggleSelect: (id: string) => void;
  toggleAllRows: (rows: Track[]) => void;
  clearSelection: () => void;
  playlists: PlaylistSummary[] | null;
  plBusy: boolean;
  addSelectedToPlaylist: (t: { playlistId?: string; name?: string }) => Promise<void>;

  // Mood vocabulary for the inline editor. Only the browse response carries
  // it, so other tabs trigger a one-row browse rather than bundling the list.
  vocab: string[];
  seedVocab: (v: string[]) => void;
  ensureVocab: () => Promise<void>;

  queuing: string | null;
  retagging: string | null;
  flashId: string | null;
  editingId: string | null;
  manualBusy: string | null;
  eraBusy: string | null;
  blocking: string | null;
  queueTrack: (t: Track) => Promise<void>;
  retagTrack: (t: Track) => Promise<void>;
  onEditTrack: (t: Track) => void;
  cancelEdit: () => void;
  saveManualTag: (
    t: Track, moods: string[], energy: string | null, applyToAlbum: boolean,
  ) => Promise<void>;
  saveEraYear: (t: Track, originalYear: number | null, applyToAlbum: boolean) => Promise<void>;
  blockTrack: (t: Track, type: BlockType) => Promise<void>;
  unblockRow: (t: Track, ref: BlockRef) => Promise<void>;
  removeBlockEntry: (
    e: { type: BlockType; id: string; name?: string | null },
    opts?: { quiet?: boolean },
  ) => Promise<void>;
}

const Ctx = createContext<LibraryShared | null>(null);

export function useLibrary(): LibraryShared {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLibrary must be used inside <LibraryProvider>');
  return v;
}

export function LibraryProvider({
  adminFetch, ready, children,
}: {
  adminFetch: AdminFetch;
  ready: boolean;
  children: ReactNode;
}) {
  const qc = useQueryClient();

  // --- the two page-wide polls --------------------------------------------
  // Deliberately two queries, not one doing both: the fast loop carries only
  // the tagger snapshot so a 3s running poll doesn't drag the whole heavy
  // /settings body across each time, and neither writes the other's state —
  // that is what keeps them from racing. Both stay silent on failure (their
  // predecessors each carried a `/* transient */`): a 3s poll that toasts on a
  // blip would bury the console.
  const taggerQuery = useQuery({
    queryKey: libraryKeys.tagger(),
    queryFn: async ({ signal }) => {
      const j = await adminJson<{ tagger?: TaggerState }>(
        adminFetch, '/library/tagger', undefined, signal,
      );
      return j.tagger ?? null;
    },
    enabled: ready,
    staleTime: 0,
    refetchInterval: q => (q.state.data?.running ? 3_000 : 10_000),
  });
  const tagger = taggerQuery.data ?? null;

  const coverageQuery = useQuery({
    queryKey: libraryKeys.coverage(),
    queryFn: ({ signal }) => adminJson<Coverage>(
      adminFetch, '/library/coverage', undefined, signal,
    ),
    enabled: ready,
    staleTime: 0,
    // While a run is live, poll faster so the % visibly climbs.
    refetchInterval: tagger?.running ? 3_000 : 60_000,
  });
  const coverage = coverageQuery.data ?? null;
  const reloadCoverage = useCallback(
    () => qc.invalidateQueries({ queryKey: libraryKeys.coverage() }).then(() => undefined),
    [qc],
  );

  // Re-marks the rows already loaded: refetching every tab would lose
  // pagination and re-hit Navidrome, and matching client-side would duplicate
  // the normalised-name rules in music/blocklist.ts, free to drift.
  //
  // The rows come from the query cache rather than a registry of mounted lists,
  // which is the whole point of the conversion — and it reaches lists a tab
  // switch has unmounted but not yet evicted, so returning to one shows correct
  // marks instead of stale ones.
  const restampBlockMarks = useCallback(async () => {
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
          adminFetch,
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
      // Enrichment, not the operation — the block itself succeeded, so leave
      // the last-known marks rather than toasting.
    }
  }, [adminFetch, qc]);

  // --- likes (#1253) -------------------------------------------------------
  const [liking, setLiking] = useState<string | null>(null);

  const likeIndexQuery = useQuery({
    queryKey: libraryKeys.likeIndex(),
    queryFn: async ({ signal }) => {
      const j = await adminJson<{ songs?: LikeIndex }>(
        adminFetch, '/likes/index', undefined, signal,
      );
      return j.songs || {};
    },
    enabled: ready,
  });
  // A missing index just means no hearts are lit — never toast this, and never
  // let a failed fetch read as "some hearts unknown". Memoised because the
  // fallback would otherwise be a fresh object per render, which invalidates
  // the whole context value and re-renders every tab.
  const likeIndex = useMemo(() => likeIndexQuery.data ?? EMPTY_LIKES, [likeIndexQuery.data]);

  // Patches the index without a refetch so the heart responds immediately.
  // The Liked list's own row removal rides applyLikeChange with a null `next`.
  const patchLike = useCallback((
    id: string, next: { count: number; operator: boolean } | null,
  ) => {
    qc.setQueryData<LikeIndex>(libraryKeys.likeIndex(), prev => {
      const out = { ...(prev || {}) };
      if (next && next.count > 0) out[id] = next; else delete out[id];
      return out;
    });
    applyLikeChange(qc, id, next && next.count > 0 ? next : null);
  }, [qc]);

  const toggleLike = useCallback(async (track: Track, isLiked: boolean) => {
    const before = likeIndex[track.id]
      ?? { count: track.likeCount ?? 0, operator: !!track.likedByOperator };
    setLiking(track.id);
    // Optimistic: the operator's own heart is +1/-1 on the total.
    patchLike(track.id, {
      count: Math.max(0, before.count + (isLiked ? -1 : 1)),
      operator: !isLiked,
    });
    try {
      const j = isLiked
        ? await adminJson<{ count?: number }>(
          adminFetch,
          `/likes/song/${encodeURIComponent(track.id)}/operator`,
          { method: 'DELETE' },
        )
        : await adminJson<{ count?: number }>(
          adminFetch,
          `/likes/song/${encodeURIComponent(track.id)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: track.title, artist: track.artist, album: track.album,
              genre: track.genre, year: track.year, duration: track.duration,
            }),
          },
        );
      // Settle on the server's count — it folds in listener likes that landed
      // between render and click.
      patchLike(track.id, { count: j.count ?? 0, operator: !isLiked });
    } catch (err) {
      patchLike(track.id, before);
      notify.err(errorMessage(err));
    } finally {
      setLiking(null);
    }
  }, [adminFetch, likeIndex, patchLike]);

  // Wraps DELETE /likes/song/:id — drops LISTENER likes too, which the heart
  // deliberately never does.
  const clearLikes = useCallback(async (track: Track) => {
    setLiking(track.id);
    try {
      const j = await adminJson<{ removed?: number }>(
        adminFetch, `/likes/song/${encodeURIComponent(track.id)}`, { method: 'DELETE' },
      );
      patchLike(track.id, null);
      notify.ok(`Cleared ${j.removed ?? 0} like${j.removed === 1 ? '' : 's'} on “${track.title || track.id}”`);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setLiking(null);
    }
  }, [adminFetch, patchLike]);

  // --- selection + playlists ----------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plBusy, setPlBusy] = useState(false);

  // Fetched lazily, only once a row is selected — the Add-to-playlist bar is
  // the only consumer, and it does not exist before then. `enabled` is what the
  // old "if selected.size > 0 && playlists === null" effect said.
  const playlistsQuery = useQuery({
    queryKey: libraryKeys.playlists(),
    queryFn: async ({ signal }) => {
      const j = await adminJson<{ playlists?: PlaylistSummary[] }>(
        adminFetch, '/playlists', undefined, signal,
      );
      return j.playlists || [];
    },
    enabled: ready && selected.size > 0,
  });
  useQueryErrorToast(playlistsQuery.error, true);
  // An errored fetch reads as "no playlists", not "still loading", so the bar
  // offers the create-new path rather than spinning forever. Memoised for the
  // same reason as likeIndex above.
  const playlists = useMemo(
    () => playlistsQuery.data ?? (playlistsQuery.error ? EMPTY_PLAYLISTS : null),
    [playlistsQuery.data, playlistsQuery.error],
  );
  // Selection is per-view: ids from another tab would be invisible, and
  // "Add 12" with 9 off-screen rows is a foot-gun. The panel calls this on
  // every tab change — the provider cannot see `tab`.
  const clearSelection = useCallback(() => { setSelected(new Set()); }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllRows = useCallback((rows: Track[]) => {
    setSelected(prev => {
      const all = rows.length > 0 && rows.every(r => prev.has(r.id));
      const next = new Set(prev);
      if (all) rows.forEach(r => next.delete(r.id));
      else rows.forEach(r => next.add(r.id));
      return next;
    });
  }, []);

  const addSelectedToPlaylist = useCallback(async (target: { playlistId?: string; name?: string }) => {
    const songIds = Array.from(selected);
    if (songIds.length === 0) return;
    setPlBusy(true);
    try {
      let detailId: string | undefined;
      if (target.playlistId) {
        await adminJson(adminFetch, `/playlists/${encodeURIComponent(target.playlistId)}/tracks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songIds }),
        });
        detailId = target.playlistId;
      } else {
        const result = await adminJson<{ playlist?: { id?: string } }>(adminFetch, '/playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: target.name, songIds }),
        });
        detailId = result.playlist?.id;
      }
      await refreshPlaylistCatalogues(qc, detailId ? [detailId] : []);
      const plName = target.name
        || playlists?.find(p => p.id === target.playlistId)?.name
        || 'playlist';
      notify.ok(`added ${songIds.length} track${songIds.length === 1 ? '' : 's'} to “${plName}”`);
      setSelected(new Set());
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setPlBusy(false);
    }
  }, [adminFetch, selected, playlists, qc]);

  // --- mood vocab ----------------------------------------------------------
  const vocabQuery = useQuery({
    queryKey: libraryKeys.moodVocab(),
    queryFn: async ({ signal }) => {
      const response = await adminJson<BrowseResponse>(
        adminFetch, '/library/browse?limit=1', undefined, signal,
      );
      return response.moodVocab ?? [];
    },
    enabled: false,
  });
  const vocab = useMemo(() => vocabQuery.data ?? [], [vocabQuery.data]);
  const seedVocab = useCallback((v: string[]) => {
    if (v.length) qc.setQueryData<string[]>(
      libraryKeys.moodVocab(),
      previous => previous?.length ? previous : v,
    );
  }, [qc]);
  const ensureVocab = useCallback(async () => {
    if (vocab.length) return;
    await vocabQuery.refetch();
  }, [vocab.length, vocabQuery]);

  // --- per-row actions -----------------------------------------------------
  const [queuing, setQueuing] = useState<string | null>(null);
  const [retagging, setRetagging] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  // Separate from manualBusy: the two saves share one panel but are two
  // requests, and one spinner covering both would grey out the tag chips
  // while a year is saving.
  const [eraBusy, setEraBusy] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null);

  const flash = useCallback((id: string) => {
    setFlashId(id);
    setTimeout(() => setFlashId(curr => (curr === id ? null : curr)), 1100);
  }, []);

  const queueTrack = useCallback(async (track: Track) => {
    setQueuing(track.id);
    try {
      const j = await adminJson<{ queuePosition?: number }>(adminFetch, '/dj/queue-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track),
      });
      notify.ok(`queued “${track.title}” · position ${j.queuePosition}`);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setQueuing(null);
    }
  }, [adminFetch]);

  const retagTrack = useCallback(async (track: Track) => {
    setRetagging(track.id);
    try {
      const j = await adminJson<{ moods?: string[]; energy?: string | null }>(adminFetch, '/library/retag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track),
      });
      const tagStr = j.moods?.length ? j.moods.join(', ') : '—';
      notify.ok(`retagged · ${tagStr} [${j.energy || '?'}]`);
      flash(track.id);
      // The server stamps retagged rows source='llm'.
      applyTagEvent(qc, {
        track, moods: j.moods || [], energy: j.energy ?? null,
        cleared: false, applyToAlbum: false, source: 'llm',
      });
      reloadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setRetagging(null);
    }
  }, [adminFetch, qc, flash, reloadCoverage]);

  const onEditTrack = useCallback((t: Track) => {
    setEditingId(curr => {
      if (curr === t.id) return null;
      ensureVocab();
      return t.id;
    });
  }, [ensureVocab]);

  const cancelEdit = useCallback(() => { setEditingId(null); }, []);

  const saveManualTag = useCallback(async (
    track: Track, moods: string[], energy: string | null, applyToAlbum: boolean,
  ) => {
    setManualBusy(track.id);
    try {
      const j = await adminJson<{ ok?: boolean; updated?: number; cleared?: boolean }>(
        adminFetch,
        '/library/manual-tag',
        {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: track.id, moods, energy, applyToAlbum }),
        },
      );
      const cleared = !!j.cleared;
      const n = j.updated ?? 1;
      const scope = applyToAlbum ? `${n} album track${n === 1 ? '' : 's'}` : 'track';
      notify.ok(cleared ? `cleared tags · ${scope}` : `tagged ${scope} · ${moods.join(', ') || '—'}`);
      setEditingId(null);
      flash(track.id);
      applyTagEvent(qc, { track, moods, energy, cleared, applyToAlbum, source: 'manual' });
      reloadCoverage();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setManualBusy(null);
    }
  }, [adminFetch, qc, flash, reloadCoverage]);

  // The manual era override (#1418). Deliberately does NOT touch coverage or
  // the untagged list — an original year is not a tag, and the track's tagging
  // state is unchanged by it. The editor stays OPEN afterwards, unlike a tag
  // save: setting a year is often the first of several corrections on the same
  // row, and the source note updating in place is the confirmation.
  const saveEraYear = useCallback(async (
    track: Track, originalYear: number | null, applyToAlbum: boolean,
  ) => {
    setEraBusy(track.id);
    try {
      const j = await adminJson<{ ok?: boolean; updated?: number; cleared?: boolean; tracks?: Array<{ id: string }> }>(
        adminFetch,
        '/library/original-year',
        {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: track.id, originalYear, applyToAlbum }),
        },
      );
      const n = j.updated ?? 1;
      const scope = applyToAlbum ? `${n} album track${n === 1 ? '' : 's'}` : 'track';
      notify.ok(originalYear == null
        ? `cleared the year override · ${scope}`
        : `era year ${originalYear} · ${scope}`);
      flash(track.id);
      applyEraYearEvent(qc, {
        originalYear,
        // Current controllers return the authoritative target set. The
        // fallback keeps a newer web build safe against an older controller:
        // patch the selected row only instead of guessing album identity.
        trackIds: j.tracks?.map((t) => t.id) ?? [track.id],
      });
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setEraBusy(null);
    }
  }, [adminFetch, qc, flash]);

  // --- blocklist -----------------------------------------------------------
  // Shared by the Blocked tab's Unblock, the row-level unblock and the block
  // toast's Undo, so all three get the same list update and re-mark.
  const removeBlockEntry = useCallback(async (
    e: { type: BlockType; id: string; name?: string | null },
    { quiet = false }: { quiet?: boolean } = {},
  ) => {
    try {
      await adminResponse(
        adminFetch,
        `/library/blocklist/${e.type}/${encodeURIComponent(e.id)}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (!(error instanceof AdminResponseError) || error.status !== 404) throw error;
    }
    // The Blocked tab's list is a query like any other — invalidating reaches
    // it whether or not that tab is mounted, which is what registerBlockList
    // existed to do.
    void qc.invalidateQueries({ queryKey: libraryKeys.blocked() });
    if (!quiet) notify.ok(`“${e.name || e.id}” can play again`);
    await restampBlockMarks();
  }, [adminFetch, qc, restampBlockMarks]);

  const blockTrack = useCallback(async (track: Track, type: BlockType) => {
    setBlocking(track.id);
    try {
      const j = await adminJson<{ entry?: BlockEntry; purged?: number }>(adminFetch, '/library/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, trackId: track.id }),
      });
      const what = type === 'track' ? `“${track.title}”` : type === 'album' ? `album “${track.album}”` : track.artist;
      const entry = j.entry;
      // Undo rather than a confirm dialog: the row badge keeps a wrong scope
      // visible even after the toast goes.
      const msg = `${what} will never air${j.purged ? ` · ${j.purged} dropped from queue` : ''}`;
      if (entry) {
        notify.undo(msg, () => {
          removeBlockEntry(entry, { quiet: true })
            .then(() => notify.ok(`“${entry.name || entry.id}” can play again`))
            .catch(err => notify.err(errorMessage(err)));
        });
      } else {
        notify.ok(`${msg} — manage in the Blocked tab`);
      }
      void qc.invalidateQueries({ queryKey: libraryKeys.blocked() });
      await restampBlockMarks();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBlocking(null);
    }
  }, [adminFetch, qc, removeBlockEntry, restampBlockMarks]);

  // Lifts whichever entry matched this row — possibly an album or artist block
  // made from a different row entirely. Rule refs never reach here (TrackTable
  // offers no one-click unblock for them — a rule can block hundreds of rows),
  // so the guard is a type-level formality.
  const unblockRow = useCallback(async (track: Track, ref: BlockRef) => {
    if (ref.kind === 'rule') return;
    setBlocking(track.id);
    try {
      await removeBlockEntry(ref);
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBlocking(null);
    }
  }, [removeBlockEntry]);

  const value = useMemo<LibraryShared>(() => ({
    adminFetch, ready, coverage, reloadCoverage, tagger, restampBlockMarks,
    likeIndex, liking, toggleLike, clearLikes,
    selected, toggleSelect, toggleAllRows, clearSelection,
    playlists, plBusy, addSelectedToPlaylist,
    vocab, seedVocab, ensureVocab,
    queuing, retagging, flashId, editingId, manualBusy, eraBusy, blocking,
    queueTrack, retagTrack, onEditTrack, cancelEdit, saveManualTag, saveEraYear,
    blockTrack, unblockRow, removeBlockEntry,
  }), [
    adminFetch, ready, coverage, reloadCoverage, tagger, restampBlockMarks,
    likeIndex, liking, toggleLike, clearLikes,
    selected, toggleSelect, toggleAllRows, clearSelection,
    playlists, plBusy, addSelectedToPlaylist,
    vocab, seedVocab, ensureVocab,
    queuing, retagging, flashId, editingId, manualBusy, eraBusy, blocking,
    queueTrack, retagTrack, onEditTrack, cancelEdit, saveManualTag, saveEraYear,
    blockTrack, unblockRow, removeBlockEntry,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
