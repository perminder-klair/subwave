'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminJson, adminResponse } from '../../../lib/admin-query';
import type { TaggerState } from '../LibraryTaggingPanel';
import { useLibrary } from './LibraryContext';
import { libraryKeys } from './queries';

import { mergeRunLog, orphanRunLog, type RunLogFileInfo, type RunLogPage, type RunLogView } from './run-log';

export type { RunLogFileInfo, RunLogView } from './run-log';

const POLL_MS = 2_000;

// The run log behind the Library page's log box: read by sequence number, so
// a run that prints faster than the poll still shows every line, plus the
// list of kept run files for download. Polls only while the box is open.
export function useTaggerRunLog(open: boolean, tagger: TaggerState | null) {
  const { adminFetch, ready } = useLibrary();
  const qc = useQueryClient();
  const running = !!tagger?.running;
  const runId = tagger?.runLogId ?? null;

  const logQuery = useQuery({
    queryKey: libraryKeys.taggerLog(),
    queryFn: async ({ signal }) => {
      const prev = qc.getQueryData<RunLogView | null>(libraryKeys.taggerLog());
      const after = prev?.nextSeq ?? 0;
      const run = prev?.runId ? `&run=${encodeURIComponent(prev.runId)}` : '';
      const j = await adminJson<{ log?: RunLogPage | null }>(
        adminFetch, `/library/tagger/log?after=${after}${run}`, undefined, signal,
      );
      return j.log ? mergeRunLog(prev, j.log) : orphanRunLog(prev);
    },
    enabled: ready && open,
    staleTime: 0,
    // `running` clears on the child's 'exit'; its last lines and the [exit]
    // line can land after that, so keep reading until the log says closed.
    refetchInterval: (q) => (running || (q.state.data && !q.state.data.closed) ? POLL_MS : false),
  });

  const filesQuery = useQuery({
    queryKey: libraryKeys.taggerLogFiles(),
    queryFn: async ({ signal }) => {
      const j = await adminJson<{ logs?: RunLogFileInfo[] }>(
        adminFetch, '/library/tagger/logs', undefined, signal,
      );
      return j.logs ?? [];
    },
    enabled: ready && open,
    staleTime: 0,
  });

  // A run that just started or ended moves the poll at once, and a new run
  // has a new file: one read each time the run state or id moves.
  const seen = useRef<{ running: boolean; runId: string | null } | null>(null);
  useEffect(() => {
    const was = seen.current;
    seen.current = { running, runId };
    if (!was || !open) return;
    if (was.running !== running || was.runId !== runId) {
      void qc.invalidateQueries({ queryKey: libraryKeys.taggerLog(), exact: true });
      void qc.invalidateQueries({ queryKey: libraryKeys.taggerLogFiles(), exact: true });
    }
  }, [running, runId, open, qc]);

  const download = useCallback(async (id: string) => {
    // admin-query-imperative: tagger-log-download
    const r = await adminResponse(adminFetch, `/library/tagger/logs/${encodeURIComponent(id)}`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [adminFetch]);

  return {
    log: logQuery.data ?? null,
    files: filesQuery.data ?? [],
    download,
  };
}
