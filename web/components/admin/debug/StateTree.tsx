'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { File, Link2 } from 'lucide-react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { fmtSize } from '../../../lib/format';
import { errorMessage } from '../../../lib/notify';
import { Btn } from '../ui';
import { SkeletonRows } from '@/components/ui/skeleton';
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from '@/components/ai-elements/file-tree';
import {
  debugKeys,
  fetchStateListing,
  type StateEntry,
  type StateListing,
} from './queries';

// Read-only browser for the station's state dir, backed by GET /debug/state-tree.
//
// Deliberately NOT on the panel's 2s /debug poll: re-fetching a filesystem tree
// every two seconds would fight the operator's expansion state, and there is no
// live signal in it worth that cost. Loads on mount, reloads on Refresh.
//
// Loading is lazy per directory — one request per expand, never a walk. The tree
// is driven CONTROLLED (`expanded` + `onExpandedChange`) rather than left to its
// own internal state, because expanding a folder is what triggers the fetch: the
// callback IS the load hook. The endpoint caps each listing and reports the real
// `total`, which is what the truncation row renders; state/stems routinely holds
// tens of thousands of dirs.

type DirState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; entries: StateEntry[]; shown: number; total: number };

/** voice/ was its own card before this tree existed — keep the DJ voice WAVs one
 *  glance away rather than one expand away. */
const DEFAULT_EXPANDED = ['voice'];

function fmtWhen(mtime?: string): string {
  if (!mtime) return '—';
  const d = new Date(mtime);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function StateTree() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(DEFAULT_EXPANDED));
  const [queried, setQueried] = useState<Set<string>>(
    () => new Set(['', ...DEFAULT_EXPANDED]),
  );
  const paths = useMemo(() => [...queried], [queried]);
  const listings = useQueries({
    queries: paths.map(path => ({
      queryKey: debugKeys.stateFile(path),
      enabled: hydrated && !needsAuth,
      staleTime: 0,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchStateListing(adminFetch, path, signal),
    })),
  });
  const dirs = useMemo<Record<string, DirState>>(() => {
    const next: Record<string, DirState> = {};
    paths.forEach((path, index) => {
      const query = listings[index];
      const listing = query?.data as StateListing | undefined;
      if (query?.error) {
        next[path] = { status: 'error', error: errorMessage(query.error) };
      } else if (!listing) {
        next[path] = { status: 'loading' };
      } else if (listing.error || !Array.isArray(listing.entries)) {
        next[path] = { status: 'error', error: listing.error || 'unexpected response' };
      } else {
        next[path] = {
          status: 'ready',
          entries: listing.entries,
          shown: listing.shown ?? listing.entries.length,
          total: listing.total ?? listing.entries.length,
        };
      }
    });
    return next;
  }, [listings, paths]);
  const root = (listings[paths.indexOf('')]?.data as StateListing | undefined)?.root ?? null;

  const load = useCallback((path: string) => {
    setQueried(current => current.has(path) ? current : new Set([...current, path]));
  }, []);

  /** The lazy-load hook: a path that has just been expanded and was never fetched
   *  gets its one listing here. A cached one re-opens with no request at all. */
  const onExpandedChange = useCallback((next: Set<string>) => {
    setExpanded(next);
    for (const p of next) {
      if (!dirs[p]) load(p);
    }
  }, [dirs, load]);

  // Every path known to be a directory, so a click on a folder's NAME can be told
  // apart from a click on a file's.
  const dirPaths = useMemo(() => {
    const out = new Set<string>();
    for (const [parent, state] of Object.entries(dirs)) {
      if (state.status !== 'ready') continue;
      for (const e of state.entries) {
        if (e.isDir) out.add(parent ? `${parent}/${e.name}` : e.name);
      }
    }
    return out;
  }, [dirs]);

  /** A folder row carries TWO buttons: the chevron toggles expansion, the name
   *  only fires onSelect. For a file browser that reads as a broken row — the
   *  name is the bigger target and clicking it did nothing — so selecting a
   *  directory toggles it, and only the chevron-sized hit area stays optional. */
  const onSelect = useCallback((path: string) => {
    if (!dirPaths.has(path)) return; // a file: nothing to open
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!dirs[path]) load(path);
    }
    setExpanded(next);
  }, [dirPaths, expanded, dirs, load]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: debugKeys.stateFiles() });
  }, [queryClient]);

  const rootState = dirs[''];

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <span className="caption break-all">{root || 'state dir'}</span>
        <span className="ml-auto">
          <Btn sm onClick={refresh}>Refresh</Btn>
        </span>
      </div>

      {!rootState || rootState.status === 'loading' ? (
        <SkeletonRows rows={6} />
      ) : rootState.status === 'error' ? (
        <span className="field-hint italic">{rootState.error}</span>
      ) : (
        <FileTree
          className="border-separator-strong bg-transparent text-[11px]"
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          onSelect={onSelect}
        >
          <DirNodes dirs={dirs} path="" />
        </FileTree>
      )}
    </div>
  );
}

/** One directory's already-loaded entries. Recurses through FileTreeFolder, whose
 *  CollapsibleContent only mounts children while the folder is open — so a
 *  collapsed subtree costs nothing, and indentation comes from the DOM nesting
 *  rather than a computed per-level padding. */
function DirNodes({ dirs, path }: { dirs: Record<string, DirState>; path: string }) {
  const state = dirs[path];
  if (!state || state.status === 'loading') return <SkeletonRows rows={2} />;
  if (state.status === 'error') return <div className="field-hint py-1 italic">{state.error}</div>;
  if (state.entries.length === 0) return <div className="field-hint py-1 italic">empty</div>;

  const truncated = state.total > state.shown;

  return (
    <>
      {state.entries.map(e => {
        const childPath = path ? `${path}/${e.name}` : e.name;
        return e.isDir ? (
          <FileTreeFolder key={childPath} name={e.name} path={childPath}>
            <DirNodes dirs={dirs} path={childPath} />
          </FileTreeFolder>
        ) : (
          // Children REPLACE the default icon+name row rather than appending to
          // it, so the whole row is composed here — dropping in only the meta
          // column would erase the filename.
          <FileTreeFile key={childPath} name={e.name} path={childPath}>
            <span className="size-4 shrink-0" />
            <FileTreeIcon>
              {e.isSymlink ? <Link2 className="size-4 text-muted" /> : <File className="size-4 text-muted" />}
            </FileTreeIcon>
            <FileTreeName>{e.name}</FileTreeName>
            <span className="ml-auto flex shrink-0 items-center gap-3 pl-3 text-muted">
              <span className="mono-num">{fmtSize(e.size)}</span>
              <span className="mono-num w-[92px] text-right">{fmtWhen(e.mtime)}</span>
            </span>
          </FileTreeFile>
        );
      })}
      {truncated && (
        <div className="field-hint py-1 italic">
          … showing {state.shown.toLocaleString('en-GB')} of {state.total.toLocaleString('en-GB')}
        </div>
      )}
    </>
  );
}
