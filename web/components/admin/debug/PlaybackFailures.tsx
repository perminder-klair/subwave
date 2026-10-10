'use client';

import { useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { adminResponse, useAdminQuery } from '../../../lib/admin-query';
import { errorMessage } from '../../../lib/notify';
import { Btn, Card } from '../ui';
import { debugKeys, fetchPlaybackFailures } from './queries';
import type { DebugData, PlaybackFailureHistory } from './types';

export function PlaybackFailures({ timezone, locale }: Pick<DebugData, 'timezone' | 'locale'>) {
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const [loaded, setLoaded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  // Silent query errors rendered inline. Disabled even after loading: only an
  // explicit button press scans history, never a remount or background poll.
  const history = useAdminQuery<PlaybackFailureHistory>({
    key: debugKeys.playbackFailures(), adminFetch, enabled: false,
    request: (fetcher, signal) => fetchPlaybackFailures(fetcher, signal),
  });
  const load = () => { setLoaded(true); void history.refetch(); };
  const download = async () => {
    setExporting(true); setDownloadNotice(null);
    try {
      // admin-query-imperative: playback-failure-export
      const response = await adminResponse(adminFetch, '/debug/playback-failures/export');
      const url = URL.createObjectURL(await response.blob());
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'subwave-playback-failures.ndjson';
        document.body.appendChild(a); a.click(); a.remove();
      } finally { URL.revokeObjectURL(url); }
      setDownloadNotice(response.headers.get('X-History-Warnings') !== '0'
        ? 'Downloaded results may be incomplete: some history could not be read.'
        : response.headers.get('X-History-Truncated') === 'true'
          ? 'Downloaded newest 1000 attempts; older retained attempts were omitted.' : 'Download ready.');
    } catch (err) { setDownloadNotice(`Download failed: ${errorMessage(err)}`); }
    finally { setExporting(false); }
  };
  return (
    <Card title="Failed track fetches" sub="on demand · best-effort history">
      <div className="grid gap-3 text-sm">
        <p>Confirmed fetch failures for controller-queued songs. Causes can include missing files, stale track IDs, network or authentication problems. Automatic fallback, decoding, mid-track, local, jingle and voice failures are outside this history.</p>
        <p>List and download show the newest 1000 failed attempts retained for {history.data?.retentionDays ?? 14} days, by UTC date.</p>
        <div className="flex flex-wrap gap-2">
          <Btn sm onClick={load} disabled={!hydrated || needsAuth || history.isFetching}>{history.isFetching ? 'Loading…' : loaded ? 'Refresh failures' : 'Load failures'}</Btn>
          <Btn sm onClick={download} disabled={!hydrated || needsAuth || exporting}>{exporting ? 'Downloading…' : 'Download NDJSON'}</Btn>
        </div>
        {history.error && <p role="alert">History read failed: {errorMessage(history.error)}. Previously loaded rows may be stale.</p>}
        {history.data?.warnings.map((warning, i) => <p role="alert" key={i}>{warning}</p>)}
        {history.data?.truncated && <p>Only the newest 1000 attempts are shown; older retained attempts were omitted.</p>}
        {downloadNotice && <p role="status">{downloadNotice}</p>}
        {loaded && !history.isFetching && !history.error && history.data?.failures.length === 0 && (
          <p>{history.data.warnings.length ? 'No readable failure records found; history is incomplete.' : 'No confirmed failed track fetches in retained history.'}</p>
        )}
        <ul className="grid max-h-96 gap-3 overflow-auto">
          {history.data?.failures.map(row => (
            <li key={row.attemptId} className="grid gap-1 border-b border-separator-strong pb-2 break-words">
              <time dateTime={row.t}>{new Date(row.t).toLocaleString(locale || 'en-GB', { timeZone: timezone })}</time>
              <span>{row.title || 'Unknown title'} — {row.artist || 'Unknown artist'} · {row.album || 'Unknown album'}</span>
              <span>{row.source} · Fetch: source resolution failed</span>
              <span>Backend ID: <code className="break-all select-all">{row.sourceTrackId || 'Unknown'}</code></span>
              <span>Attempt: <code className="break-all select-all">{row.attemptId}</code></span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
