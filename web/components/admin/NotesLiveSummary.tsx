'use client';

import Link from 'next/link';
import NotesHelp from './NotesHelp';
import type { ReactNode } from 'react';
import { adminJson, useAdminMutation, useAdminQuery, type AdminFetch } from '../../lib/admin-query';
import { cn } from '../../lib/cn';
import { notify } from '../../lib/notify';
import { Card, Eyebrow } from './ui';

type TrackSummary = {
  track: { id: string | null; title: string; artist: string; album: string; artistId?: string | null; albumId?: string | null };
  djLine: string | null;
  availability?: { matchingCount: number; availableCount: number } | null;
  spark: { wording: string; airedAt: string | null; renderedAt: string | null; factDetected: boolean;
    passReason: string | null; qualityConcern: string | null; sourceUrl: string; entityType: string; entityId: string } | null;
};
type LiveSummary = { onAir: TrackSummary | null; nextUp: TrackSummary | null };
type SegmentRun = { queued: boolean; deferred: boolean; reason: string | null };

export default function NotesLiveSummary({ adminFetch, enabled, children }: { adminFetch: AdminFetch; enabled: boolean; children?: ReactNode }) {
  const live = useAdminQuery<LiveSummary>({
    key: ['sleeve-notes', 'live-summary'], adminFetch,
    request: (fetcher, signal) => adminJson(fetcher, '/sleeve-notes/live-summary', undefined, signal),
    staleTime: 4_000, refetchInterval: 5_000,
  });
  const run = useAdminMutation<SegmentRun, void>({
    adminFetch,
    request: (_vars, fetcher) => adminJson(fetcher, '/sleeve-notes/segment/run', { method: 'POST' }),
    onDone: async (result, _vars, client) => {
      if (result.queued) notify.ok(result.deferred ? 'Sleeve Notes segment queued for the next break.' : 'Sleeve Notes segment submitted to broadcast.');
      else notify.info(`Sleeve Notes stayed silent — ${result.reason || 'nothing usable to speak from'}`);
      await client.invalidateQueries({ queryKey: ['sleeve-notes'] });
    },
  });
  const runButton = <button type="button" onClick={() => run.mutate()} disabled={run.isPending || !live.data?.onAir?.track.id}
    title="Run a Sleeve Notes segment for the on-air track, bypassing automatic enablement, DJ assignments and cooldowns."
    className={cn('seg-pad seg-pad--slim min-h-9 sm:min-h-0', run.isPending && 'is-firing')}>
    <span className="seg-led" aria-hidden />
    <span className="seg-label">{run.isPending ? 'Working…' : 'Run Segment'}</span>
  </button>;
  return <div className="space-y-2">
    <div className="grid items-stretch gap-4 md:grid-cols-2 [&>.card]:min-h-[19rem]">
      <Summary title="On air" item={live.data?.onAir} loading={live.isLoading} unavailable={!!live.error} enabled={enabled} action={<div className="flex items-center gap-1">{runButton}<NotesHelp text="Run a segment about the current track now. This skips the automatic on/off switch, DJ selection and cooldown, but still checks for usable stories and enough airtime." /></div>} />
      <Summary title="Next up" item={live.data?.nextUp} loading={live.isLoading} unavailable={!!live.error} enabled={enabled} />
      {children}
    </div>
    {live.error && <p role="status" className="text-xs text-muted">Live summaries could not be refreshed. <button type="button" className="text-primary hover:underline" onClick={() => void live.refetch()}>Retry</button></p>}
  </div>;
}
function Summary({ title, item, loading, unavailable, enabled, action }: { title: string; item?: TrackSummary | null; loading: boolean; unavailable: boolean; enabled: boolean; action?: ReactNode }) {
  const spark = item?.spark;
  const artistHref=item?.track.artistId?`/admin/notes?tab=connections&focusType=library-artist&focusId=${encodeURIComponent(item.track.artistId)}`:null;
  const albumHref=item?.track.albumId?`/admin/notes?tab=connections&focusType=library-album&focusId=${encodeURIComponent(item.track.albumId)}`:null;
  const trackHref=albumHref&&item?.track.id?`${albumHref}&brainTrack=${encodeURIComponent(item.track.id)}`:null;
  const status = spark?.airedAt ? spark.factDetected && spark.renderedAt ? 'Aired · Spark use detected' : 'Aired · Spark use not detected'
    : spark?.passReason ? 'DJ passed on this Spark'
      : spark?.qualityConcern ? 'DJ flagged this Spark'
        : spark?.renderedAt ? 'DJ speech prepared' : item?.djLine ? 'DJ line drafted' : 'Link not prepared yet';
  return <Card headingLevel={2} title={title} headClass="min-h-[59px] sm:min-h-[53px]" sub={unavailable && item ? 'Last received summary · refresh unavailable' : undefined} right={action}>
    {loading && !item ? <p className="text-[13px] text-muted">Reading the station…</p>
      : !item ? <p className="text-[13px] text-muted">{unavailable ? 'Live summary unavailable.' : title === 'On air' ? 'No track is currently reported on air.' : 'No track is queued yet.'}</p>
        : <div className="space-y-3">
          <div><h3 className="text-sm font-semibold break-words">{artistHref?<Link href={artistHref} title="Open artist in Station Brain" className="hover:underline">{item.track.artist || 'Unknown artist'}</Link>:item.track.artist || 'Unknown artist'} · {trackHref?<Link href={trackHref} title="Select track in Station Brain" className="hover:underline">{item.track.title || 'Untitled track'}</Link>:item.track.title || 'Untitled track'}</h3>
            <p className="mt-1 text-xs break-words text-muted">{albumHref?<Link href={albumHref} title="Open album in Station Brain" className="hover:underline">{item.track.album || 'Album not recorded'}</Link>:item.track.album || 'Album not recorded'}</p></div>
          <div className="border-t border-border/60 pt-3">
            <div className="flex items-center gap-1"><Eyebrow>Story Spark</Eyebrow><NotesHelp text="A Spark is a saved fact offered to the DJ. The DJ may use it, paraphrase it or pass. Stored matches can be unavailable because they were used recently or reserved for another segment." /></div>
            <p className="mt-1 text-[13px] leading-relaxed break-words">{spark?.wording || (item.availability ? `${item.availability.matchingCount} stored Spark${item.availability.matchingCount === 1 ? '' : 's'} match${item.availability.matchingCount === 1 ? 'es' : ''} this track.` : 'Spark availability is not known for this track.')}</p>
            {spark && <p className="mt-2 text-xs text-muted">{status}</p>}
            {spark?.airedAt && spark.passReason && <p className="text-xs text-muted">DJ pass: {spark.passReason}</p>}
            {spark?.airedAt && spark.qualityConcern && <p className="text-xs text-muted">DJ concern: {spark.qualityConcern}</p>}
            {!spark && item.availability && <p className="mt-2 text-xs text-muted">{!enabled ? 'Sleeve Notes is paused.'
              : item.availability.availableCount > 0 ? `${item.availability.availableCount} available for the DJ to consider.`
                : item.availability.matchingCount > 0 ? 'All are currently on cooldown or reserved.'
                  : 'Matching stories may become available as research progresses.'}</p>}
            {spark && <div className="mt-2 flex flex-wrap gap-3 text-xs text-primary">
              <Link href={`/admin/notes?tab=stories&storyType=${encodeURIComponent(spark.entityType)}&storyId=${encodeURIComponent(spark.entityId)}`}>Saved story</Link>
              {spark.sourceUrl && <a href={spark.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a>}
            </div>}
          </div>
          {item.djLine ? <details className="border-t border-border/60 pt-2 text-xs"><summary className="cursor-pointer">DJ line{spark?.airedAt ? ' · aired' : ' · prepared'}</summary>
            <p className="mt-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{item.djLine}</p></details>
            : title==='On air'?<p className="text-xs text-muted">No DJ speech recorded for this play yet.</p>:null}
        </div>}
  </Card>;
}
