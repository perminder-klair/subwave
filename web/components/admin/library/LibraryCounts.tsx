'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Ban, Download, History, Library, Radio, Server, TriangleAlert } from 'lucide-react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { relTime } from '../../../lib/format';
import { cn } from '../../../lib/cn';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';
import type { Tab } from './types';
import { adminResponse } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import { Btn } from '../ui';
import { useLibrary } from './LibraryContext';

// The Library page's counts line: six equal tiles, each its own theme colour,
// each explained on hover (or keyboard focus). The figures come from the
// controller's `coverage.overview` (music/library-overview.ts) and the music
// server's last count (`coverage.total`). Words stay backend-neutral: SUB/WAVE
// runs on any Subsonic-compatible server, so it is "the music server" here.

export interface LibraryOverview {
  library: number;
  canAir: number;
  taggedCanAir: number;
  djReady: number;
  blocked: { total: number; track: number; album: number; artist: number; rule: number };
  lengthLimits: { show: string | null; minSec: number | null; maxSec: number | null; within: number } | null;
  aired: { windowDays: number; recent: number; ever: number; never: number; since: string | null };
  attention: { eraAlbums: number; unmeasurable: number; remeasure: number; yearFailed: number; analysisFailed: number; damaged: number; total: number };
  computedAt: string;
}

const num = (n: number | null | undefined) => (n == null ? '…' : n.toLocaleString('en-GB'));
const share = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(1)} %` : '—');
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

function dayLabel(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function limitsLabel(l: NonNullable<LibraryOverview['lengthLimits']>): string {
  const parts = [l.minSec != null ? `≥ ${l.minSec} s` : null, l.maxSec != null ? `≤ ${l.maxSec} s` : null].filter(Boolean);
  return parts.join(', ');
}

function Tile({ tone, icon, label, value, sub, tip, onOpen, openLabel, href }: {
  tone: 'library' | 'air' | 'never' | 'aired' | 'needs' | 'needs-clear' | 'server';
  icon: ReactNode;
  label: string;
  value: string;
  sub: ReactNode;
  tip: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
  // An outside page, opened in a new tab (the music server's own UI).
  href?: string | null;
}) {
  const body = (
    <>
      <span className="lib-count-k">{icon}<span>{label}</span></span>
      <span className="lib-count-n mono-num">{value}</span>
      <span className="lib-count-s">{sub}</span>
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className={cn('lib-count', `lib-count--${tone}`, 'lib-count-link')} aria-label={openLabel}>
            {body}
          </a>
        ) : onOpen ? (
          <button type="button" className={cn('lib-count', `lib-count--${tone}`, 'lib-count-link')} onClick={onOpen} aria-label={openLabel}>
            {body}
          </button>
        ) : (
          <div className={cn('lib-count', `lib-count--${tone}`)} tabIndex={0}>
            {body}
          </div>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="lib-count-tip">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

export function LibraryCounts({ overview: o, serverTotal, countedAt, scanning, onOpenTab, musicServerUrl }: {
  overview: LibraryOverview | null;
  serverTotal: number | null;
  countedAt: string | null;
  scanning: boolean;
  onOpenTab?: (tab: Tab) => void;
  // Already checked by music-server-link.ts: an http(s) address or null.
  musicServerUrl?: string | null;
}) {
  const { adminFetch } = useLibrary();
  const [downloading, setDownloading] = useState(false);
  // The tracks behind Needs you (unreadable, to re-measure, year lookup failed,
  // analysis gave up, damaged) as a CSV with their file paths; the Era albums have the Era
  // tab's CSV.
  const downloadAttention = async () => {
    setDownloading(true);
    try {
      // admin-query-imperative: needs-you-csv-export
      const r = await adminResponse(adminFetch, '/library/attention/csv');
      const url = URL.createObjectURL(await r.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'needs-you-tracks.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify.err(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  };
  const airedRef = useRef<HTMLSpanElement>(null);
  const restRef = useRef<HTMLSpanElement>(null);
  const neverRef = useRef<HTMLSpanElement>(null);
  const lib = o?.library ?? 0;
  const pct = (n: number) => (lib > 0 ? `${(n / lib) * 100}%` : '0%');
  useDynamicStyle(airedRef, { width: o ? pct(o.aired.recent) : '0%' });
  useDynamicStyle(restRef, { width: o ? pct(o.canAir - o.aired.recent) : '0%' });
  useDynamicStyle(neverRef, { width: o ? pct(o.blocked.total) : '0%' });

  const b = o?.blocked;
  const blockedParts = b
    ? [
        b.track ? plural(b.track, 'track') : null,
        b.album ? `${num(b.album)} via albums` : null,
        b.artist ? `${num(b.artist)} via artists` : null,
        b.rule ? `${num(b.rule)} via rules` : null,
      ].filter(Boolean).join(' · ') || 'nothing blocked'
    : '…';
  const a = o?.attention;
  const attentionParts = a
    ? [
        a.eraAlbums ? `${plural(a.eraAlbums, 'album')} to review (Era)` : null,
        a.unmeasurable ? `${plural(a.unmeasurable, 'track')} unreadable` : null,
        a.remeasure ? `${plural(a.remeasure, 'track')} to re-measure` : null,
        a.yearFailed ? `${plural(a.yearFailed, 'track')}: year lookup failed` : null,
        a.analysisFailed ? `${plural(a.analysisFailed, 'track')}: analysis gave up` : null,
        a.damaged ? `${plural(a.damaged, 'track')} damaged` : null,
      ].filter(Boolean).join(' · ') || 'all clear'
    : '…';
  const gap = o && serverTotal != null ? serverTotal - o.library : null;

  return (
    <TooltipProvider delayDuration={250}>
      <div className="lib-counts">
        <Tile
          tone="library"
          icon={<Library size={15} aria-hidden />}
          label="Library"
          value={num(o?.library)}
          sub="tracks mirrored from your music server"
          onOpen={onOpenTab ? () => onOpenTab('browse') : undefined}
          openLabel="Open the Browse tab"
          tip={<>
            Every track SUB/WAVE has mirrored from your music server into its own library, blocked
            ones included. It grows when a tagging run walks the server, and Reconcile removes
            tracks that left it.
            <br /><b>Library = Can air + Never play.</b>
            <br />Click to open the Browse tab.
          </>}
        />
        <Tile
          tone="air"
          icon={<Radio size={15} aria-hidden />}
          label="Can air"
          value={num(o?.canAir)}
          sub={o ? <>
            {share(o.djReady, o.canAir)} DJ-ready
            {o.lengthLimits && <> · {o.lengthLimits.show ?? 'now'} ({limitsLabel(o.lengthLimits)}): {num(o.lengthLimits.within)}</>}
          </> : '…'}
          onOpen={onOpenTab ? () => onOpenTab('browse') : undefined}
          openLabel="Open the Browse tab"
          tip={<>
            The tracks the DJ may pick: the library minus the never-play list.
            <br /><b>DJ-ready</b> = mood &amp; energy tagged, BPM &amp; key measured, loudness measured
            (over the whole file when whole-file analysis is on). A track missing one still airs, but the DJ and the mixer know less about it.
            {o?.lengthLimits && <><br />Length limits are set per show: the second figure is what
              {o.lengthLimits.show ? ` ${o.lengthLimits.show}` : ' the show on air'} can pick from.</>}
            <br />Click to open the Browse tab.
          </>}
        />
        <Tile
          tone="never"
          icon={<Ban size={15} aria-hidden />}
          label="Never play"
          value={num(o?.blocked.total)}
          sub={blockedParts}
          onOpen={onOpenTab ? () => onOpenTab('blocked') : undefined}
          openLabel="Open the Blocked tab"
          tip={<>
            Tracks the never-play list keeps off air everywhere: picks, requests and the fallback playlist.
            Split by what blocks them; a track matched twice counts once, under its most specific entry.
            Rules count while they are active (their season and shows).
            <br />Click to open the Blocked tab.
          </>}
        />
        <Tile
          tone="aired"
          icon={<History size={15} aria-hidden />}
          label={`Aired · ${o?.aired.windowDays ?? 30} days`}
          value={num(o?.aired.recent)}
          sub={o ? <>
            {share(o.aired.recent, o.canAir)} of what can air · <b>{num(o.aired.never)}</b> never aired
            {o.aired.since && <> (since {dayLabel(o.aired.since)})</>}
          </> : '…'}
          onOpen={onOpenTab ? () => onOpenTab('history') : undefined}
          openLabel="Open the History tab"
          tip={<>
            Different tracks that went on air in the last {o?.aired.windowDays ?? 30} days, from the play history.
            The share shows how much of the library the station really uses: a low one means it keeps
            circling the same part.
            <br />Click to open the History tab.
          </>}
        />
        <Tile
          tone={a && a.total > 0 ? 'needs' : 'needs-clear'}
          icon={<TriangleAlert size={15} aria-hidden />}
          label="Needs you"
          value={num(a?.total)}
          sub={attentionParts}
          onOpen={onOpenTab && a && a.eraAlbums > 0 ? () => onOpenTab('era') : undefined}
          openLabel="Open the Era tab"
          tip={<>
            What only you can settle, as one sum of albums and tracks:
            <br />· <b>albums</b> to review in the Era tab (the same count as its &ldquo;To review&rdquo;)
            <br />· <b>tracks</b> the analyzer could not read for some measure (a silent, corrupt or unusual file), each counted once
            <br />· <b>tracks</b> with a measurement still due, not a bad file (a tail read before its edges were known): an analysis run of that measure takes them again
            <br />· <b>tracks</b> whose original-year lookup failed (not &ldquo;not found&rdquo;: an error, retried later)
            <br />· <b>tracks</b> the analysis gave up on after repeated failures
            <br />· <b>tracks</b> whose file decodes into bursts far over full scale (corrupt frames): they air too quiet or click
            <br />All clear at 0.
          </>}
        />
        <Tile
          tone="server"
          icon={<Server size={15} aria-hidden />}
          label="Music server"
          value={serverTotal != null ? num(serverTotal) : scanning ? 'counting…' : '—'}
          sub={countedAt
            ? <>counted {relTime(countedAt)} ago</>
            : scanning ? 'counting…' : 'not counted yet'}
          href={musicServerUrl}
          openLabel="Open your music server in a new tab"
          tip={<>
            Your music server&apos;s own track count, from the last full count (one request per album,
            so it is not live). Never-play tracks are on the server too, so they are counted; only
            the station archive is left out. It should match Library.
            <br />The Recount button next to &ldquo;Your library&rdquo; refreshes it.
            {musicServerUrl && <><br />Click to open your music server ({musicServerUrl}) in a new tab.</>}
          </>}
        />
      </div>

      <div className="lib-counts-bar" aria-hidden>
        <span ref={airedRef} className="seg-aired" />
        <span ref={restRef} className="seg-rest" />
        <span ref={neverRef} className="seg-never" />
      </div>
      <div className="lib-counts-legend">
        <span><i className="seg-aired" />aired in {o?.aired.windowDays ?? 30} days <b className="mono-num">{num(o?.aired.recent)}</b></span>
        <span><i className="seg-rest" />can air, not aired lately <b className="mono-num">{num(o ? o.canAir - o.aired.recent : null)}</b></span>
        <span><i className="seg-never" />never play <b className="mono-num">{num(o?.blocked.total)}</b></span>
      </div>

      {o && (
        <div className="lib-counts-check">
          <b className="mono-num">Library {num(o.library)}</b> = <b className="mono-num">can air {num(o.canAir)}</b>
          {' '}+ <b className="mono-num">never play {num(o.blocked.total)}</b>.{' '}
          {gap == null
            ? 'Recount to compare with the music server.'
            : gap === 0
              ? 'The music server agrees.'
              : gap > 0
                // Good news, so it reads in the same green as a finished run
                // (LibraryTaggingPanel's success line).
                ? <span className="text-emerald-500">The music server has <b className="mono-num">{num(gap)}</b> new {gap === 1 ? 'track' : 'tracks'} ready to import: the next tagging run walks {gap === 1 ? 'it' : 'them'} in.</span>
                : <>The music server has <b className="mono-num">{num(-gap)}</b> fewer: tracks gone from it since they were mirrored, which Reconcile removes{countedAt ? `, or tracks mirrored after its last count (${relTime(countedAt)} ago)` : ''}.</>}
        </div>
      )}

      {a && a.total - a.eraAlbums > 0 && (
        <div className="lib-counts-check flex flex-wrap items-center gap-2">
          <span>
            Needs you: <b className="mono-num">{plural(a.total - a.eraAlbums, 'track')}</b> to look at by hand
            {' '}({[
              a.unmeasurable ? `${num(a.unmeasurable)} unreadable` : null,
              a.remeasure ? `${num(a.remeasure)} to re-measure` : null,
              a.yearFailed ? `${num(a.yearFailed)} year lookup failed` : null,
              a.analysisFailed ? `${num(a.analysisFailed)} analysis gave up` : null,
              a.damaged ? `${num(a.damaged)} damaged (corrupt frames)` : null,
            ].filter(Boolean).join(', ')}).
          </span>
          <Btn sm onClick={downloadAttention} disabled={downloading}
            title="Every one of these tracks, what went wrong and where its file lives, as CSV (the Era albums are in the Era tab's own CSV)">
            <Download size={11} aria-hidden /> {downloading ? 'Preparing…' : 'Download CSV'}
          </Btn>
        </div>
      )}
    </TooltipProvider>
  );
}
