'use client';

/* Admin Stats page. Two data sources, two cadences:
   - GET /stats (5s) aggregates the in-memory LLM / TTS / DJ-log / request rings
     (since boot, lost on restart by design).
   - GET /listeners (30s) returns the durable listener time-series persisted to
     state/listeners.jsonl (24h–7d), drawn as the Audience trend chart. */

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { AdminResponseError, adminJson, useAdminQuery } from '../../lib/admin-query';
import { errorMessage } from '../../lib/notify';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Card, Btn, Pill, Eyebrow, Seg } from './ui';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/cn';
import { fmtConnected, type ListenerConnection } from '../../lib/clientLabel';
import {
  bucketSamplesByHour,
  groupConnectionsByDevice,
  type HourBucket,
} from '../../lib/audienceStats';
import { statsKeys } from './stats-queries';

interface LatencyStats {
  avg?: number;
  p50?: number;
  p95?: number;
  max?: number;
}

interface TokenStats {
  total?: number;
  input?: number;
  output?: number;
}

interface ByKindRow {
  kind: string;
  count: number;
  ok: number;
  avgMs?: number;
  tokens?: number;
}

interface ByModelRow {
  model: string;
  count: number;
  tokens?: number;
  costUsd?: number;
  priced?: boolean;
}

interface ByEngineRow {
  engine: string;
  count: number;
  ok: number;
  avgMs?: number;
}

interface ByTtsKindRow {
  kind: string;
  count: number;
  avgMs?: number;
}

interface ByDjKindRow {
  kind: string;
  count: number;
}

interface LlmStats {
  window: number;
  count: number;
  ok: number;
  failed: number;
  successRate?: number;
  latency: LatencyStats;
  tokens?: TokenStats;
  cost?: { usd: number; complete: boolean } | null;
  provider?: string;
  agent: { calls: number; avgSteps?: number; avgTools?: number };
  byKind: ByKindRow[];
  byModel: ByModelRow[];
  activeModel?: string;
  budget?: {
    enabled: boolean;
    cap: number;
    softPct: number;
    usedToday: number;
    remaining: number | null;
    mode: 'normal' | 'soft' | 'hard';
  };
}

interface TtsStats {
  window: number;
  count: number;
  ok: number;
  failed: number;
  latency: LatencyStats;
  fellBack: number;
  fallbackRate?: number;
  chars?: number;
  byEngine: ByEngineRow[];
  byKind: ByTtsKindRow[];
}

interface DjLogStats {
  count: number;
  byKind: ByDjKindRow[];
}

interface ByPathRow {
  path: string;
  count: number;
  ok: number;
}

interface ByPickSourceRow {
  source: string;
  count: number;
}

interface TopRequesterRow {
  requester: string;
  count: number;
}

interface RequestsStats {
  window: number;
  count: number;
  resolved: number;
  failed: number;
  successRate?: number | null;
  latency: LatencyStats;
  artistMiss: { count: number; rate?: number | null };
  byPath: ByPathRow[];
  byPickSource: ByPickSourceRow[];
  topRequesters: TopRequesterRow[];
}

interface StatsResponse {
  llm?: LlmStats;
  tts?: TtsStats;
  djLog?: DjLogStats;
  requests?: RequestsStats;
  error?: string;
}

interface ListenerSample {
  t: string;
  count: number;
}

interface ListenersResponse {
  current?: number | null;
  sinceMinutes?: number;
  bytes?: number;
  samples?: ListenerSample[];
  error?: string;
}

interface AudienceResponse {
  sinceMinutes?: number;
  sessions?: number;
  referrers?: { source: string; count: number }[];
  countries?: { country: string; count: number }[];
  paths?: { path: string; count: number }[];
  error?: string;
}

// Already deduped one-row-per-listener by the server. `error` is set on a 502
// (Icecast admin unreachable) so the UI can tell "nobody connected" from
// "couldn't read the live detail".
interface ConnectionsResponse {
  count?: number;
  connections?: ListenerConnection[];
  error?: string;
}

interface ContainerUsage {
  name: string;
  service: string;
  cpuPct: number;
  memUsed: number;
  memLimit: number;
  memPct: number;
}

interface HostUsage {
  cpus: number;
  loadavg: [number, number, number];
  memTotal: number;
  memUsed: number;
  uptime: number;
}

interface SystemResponse {
  t?: string;
  dockerAvailable?: boolean;
  dockerError?: string;
  host?: HostUsage;
  containers?: ContainerUsage[];
  error?: string;
}

const fmtInt = (n: number | null | undefined): string =>
  n == null ? '—' : Number(n).toLocaleString('en-GB');

const fmtMs = (n: number | null | undefined): string => {
  if (n == null) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
};

const fmtPct = (n: number | null | undefined): string =>
  n == null ? '—' : `${Math.round(n * 100)}%`;

const fmtTokens = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};

// One-decimal mean for the listener average — counts are small integers, so a
// single decimal reads better than a rounded whole.
const fmtAvg = (n: number | null | undefined): string =>
  n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-GB');

const fmtBytes = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

interface StatCellProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
  danger?: boolean;
  last?: boolean;
}

function StatCell({ label, value, sub, accent, danger, last }: StatCellProps) {
  const tone = danger ? 'text-[var(--danger)]' : accent ? 'text-vermilion' : '';
  return (
    <div
      className={cn(
        'grid gap-[3px] p-3.5',
        !last && 'border-r border-separator-soft',
      )}
    >
      <span className="caption">{label}</span>
      <span className={cn('mono-num text-[22px] leading-[1.1] font-bold', tone)}>
        {value}
      </span>
      {sub && <span className="caption text-muted">{sub}</span>}
    </div>
  );
}

interface MetricStripProps {
  children: ReactNode;
}

function MetricStrip({ children }: MetricStripProps) {
  const count = Array.isArray(children) ? children.length : 1;
  const ref = useRef<HTMLDivElement>(null);
  useDynamicStyle(ref, { gridTemplateColumns: `repeat(${count}, 1fr)` });
  // `.strip-mobile` reflows to 2 columns under 640px, but StatCell divides with
  // a RIGHT rule while that helper only clears LEFT ones, so the cell ending
  // each mobile row left a divider dangling against the card edge.
  return (
    <div
      ref={ref}
      className="strip-mobile grid border-b border-separator-strong [&>*:nth-child(even)]:border-r-0 sm:[&>*:nth-child(even):not(:last-child)]:border-r"
    >
      {children}
    </div>
  );
}

interface BarProps {
  frac?: number;
}

function Bar({ frac }: BarProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { width: `${Math.max(2, Math.round((frac || 0) * 100))}%` });
  return (
    <span className="inline-block h-1.5 w-14 shrink-0 overflow-hidden rounded-[2px] bg-separator-soft align-middle">
      <span ref={ref} className="block h-full bg-vermilion" />
    </span>
  );
}

interface TableColumn<R> {
  key: string;
  label: ReactNode;
  align?: 'left' | 'right' | 'center';
  render?: (row: R) => ReactNode;
}

interface TableProps<R> {
  cols: TableColumn<R>[];
  rows?: R[];
  empty: ReactNode;
}

function Table<R>({ cols, rows, empty }: TableProps<R>) {
  if (!rows?.length) {
    return <span className="field-hint italic">{empty}</span>;
  }
  // The wrapper is only a scroll container below sm:. From sm: up overflow-x
  // must stay `visible`, because the sticky <thead> would otherwise resolve
  // against this div instead of the ScrollBox viewport.
  return (
    <div className="w-full overflow-x-auto sm:overflow-x-visible">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {cols.map(c => (
              <th
                key={c.key}
                className={cn(
                  'caption border-b border-separator-strong px-2 py-1 whitespace-nowrap',
                  // Sticky so the header stays put when the table is wrapped in
                  // a ScrollBox; the card-bg masks rows scrolling underneath.
                  'sticky top-0 z-[1] bg-[var(--card-bg)]',
                  c.align === 'right' && 'text-right',
                  c.align === 'center' && 'text-center',
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(c => (
                <td
                  key={c.key}
                  className={cn(
                    'border-b border-separator-soft px-2 py-1 text-[12px]',
                    c.align === 'right' && 'text-right',
                    c.align === 'center' && 'text-center',
                  )}
                >
                  {c.render ? c.render(r) : ((r as Record<string, unknown>)[c.key] as ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// `max` anchors the widest bar to 100%.
interface BarRow {
  label: string;
  count: number;
  trailing?: ReactNode;
}

function BarList({ rows, max }: { rows: BarRow[]; max: number }) {
  return (
    <div className="grid gap-1.5">
      {rows.map(r => (
        // The label column gives up 22px on a phone so the bar and its trailing
        // figure still fit on one line inside a 390px card.
        <div key={r.label} className="flex items-center gap-2.5 text-[12px]">
          <span className="w-[88px] shrink-0 truncate text-muted sm:w-[110px]" title={r.label}>
            {r.label}
          </span>
          <Bar frac={r.count / (max || 1)} />
          <span className="mono-num min-w-0 font-bold">{r.trailing ?? r.count}</span>
        </div>
      ))}
    </div>
  );
}

// Caps a breakdown to a scrollable area so a long tail can't stretch the card
// down the page. Tables wrapped here keep their header visible via the sticky
// <thead> in <Table>, which resolves against the ScrollArea viewport.
function ScrollBox({ children }: { children: ReactNode }) {
  return <ScrollArea className="max-h-[260px]">{children}</ScrollArea>;
}

// Hand-rolled SVG area chart. The viewBox is a fixed 100×100 unit box stretched
// to the container (preserveAspectRatio=none), so strokes need
// vector-effect=non-scaling-stroke and labels stay out of the SVG.
function ListenerChart({ samples }: { samples: ListenerSample[] }) {
  if (!samples || samples.length < 2) {
    return (
      <div className="flex h-[130px] items-center justify-center">
        <span className="field-hint italic">collecting listener history…</span>
      </div>
    );
  }
  const W = 100;
  const H = 100;
  const counts = samples.map(s => s.count);
  const peak = Math.max(...counts);
  // 12% headroom so the peak sits just below the top edge and the dashed peak
  // line is visible rather than flush against the frame.
  const drawMax = peak > 0 ? peak * 1.12 : 1;
  const n = samples.length;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (c: number) => H - (c / drawMax) * H;
  const pts = samples.map((s, i) => `${x(i).toFixed(2)},${y(s.count).toFixed(2)}`);
  const line = `M ${pts.join(' L ')}`;
  const area = `${line} L ${W},${H} L 0,${H} Z`;
  const peakY = y(peak);
  return (
    <svg
      className="block h-[130px] w-full"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {peak > 0 && (
        <line
          x1="0"
          y1={peakY}
          x2={W}
          y2={peakY}
          stroke="var(--accent-2)"
          strokeWidth={1}
          strokeDasharray="2 3"
          opacity={0.55}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path d={area} fill="color-mix(in oklab, var(--accent) 14%, transparent)" stroke="none" />
      <path
        d={line}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// Height is per-hour dynamic, so it goes through useDynamicStyle — the lint
// rule forbids `style={…}`.
function HourColumn({ frac, title }: { frac: number; title: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { height: `${Math.max(2, Math.round(frac * 100))}%` });
  return (
    <span className="flex h-full flex-1 items-end" title={title}>
      <span ref={ref} className="block min-h-[2px] w-full rounded-[2px] bg-vermilion" />
    </span>
  );
}

// Average listeners by local hour-of-day, anchored to the busiest hour's
// average. The axis labels a few anchor hours rather than all 24 to stay legible.
function HourOfDayChart({ buckets }: { buckets: HourBucket[] }) {
  const hasData = buckets.some(b => b.samples > 0);
  if (!hasData) {
    return (
      <div className="flex h-[110px] items-center justify-center">
        <span className="field-hint italic">collecting hourly history…</span>
      </div>
    );
  }
  const maxAvg = Math.max(...buckets.map(b => b.avg), 0);
  const pad = (h: number) => String(h).padStart(2, '0');
  return (
    <div>
      <div className="flex h-[110px] items-end gap-[3px]">
        {buckets.map(b => (
          <HourColumn
            key={b.hour}
            frac={maxAvg ? b.avg / maxAvg : 0}
            title={
              b.samples
                ? `${pad(b.hour)}:00 · avg ${(Math.round(b.avg * 10) / 10)} · peak ${b.peak}`
                : `${pad(b.hour)}:00 · no data`
            }
          />
        ))}
      </div>
      <div className="caption mt-1 flex justify-between text-muted">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

const RANGE_OPTIONS = [
  { id: '1440', label: '24h' },
  { id: '10080', label: '7d' },
];

class StatsShapeError extends Error {}

export default function StatsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState('1440'); // minutes — 24h default
  const enabled = hydrated && !needsAuth && !paused;

  // /stats — usage rollups, 5s.
  const statsQuery = useAdminQuery<StatsResponse>({
    key: statsKeys.rollups(), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 5_000,
    request: async (fetcher, signal) => {
      const body = await adminJson<StatsResponse>(fetcher, '/stats', undefined, signal);
      if (!body || typeof body !== 'object' || !body.llm) {
        throw new StatsShapeError(body?.error || 'unexpected response shape from /stats');
      }
      return body;
    },
  });

  // /listeners — durable time-series for the Audience chart, 30s (it reads the
  // JSONL history file and moves slowly). Soft-fails: a miss leaves the last
  // reading in place rather than erroring the page.
  const listenersQuery = useAdminQuery<ListenersResponse>({
    key: statsKeys.listeners(range), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 30_000,
    placeholderData: previous => previous,
    request: (fetcher, signal) => adminJson(fetcher, `/listeners?sinceMinutes=${range}`, undefined, signal),
  });

  // /audience — durable referral/geo rollup, 30s, soft-fail (same cadence and
  // failure handling as /listeners).
  const audienceQuery = useAdminQuery<AudienceResponse>({
    key: statsKeys.audience(range), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 30_000,
    placeholderData: previous => previous,
    request: (fetcher, signal) => adminJson(fetcher, `/audience?sinceMinutes=${range}`, undefined, signal),
  });
  // Range is part of both cache keys. Keep a range-independent last success so
  // a first-request failure for a newly selected range cannot blank the charts
  // after TanStack releases the previous range's placeholder.
  const [lastListeners, setLastListeners] = useState<ListenersResponse | null>(null);
  const [lastAudience, setLastAudience] = useState<AudienceResponse | null>(null);
  useEffect(() => {
    if (listenersQuery.data) setLastListeners(listenersQuery.data);
  }, [listenersQuery.data]);
  useEffect(() => {
    if (audienceQuery.data) setLastAudience(audienceQuery.data);
  }, [audienceQuery.data]);

  // /listeners/connections — 30s, range-independent ("connected right now").
  // A 502 is stored as an error rather than dropped, so the card can say "live
  // detail unavailable" instead of silently blanking.
  const connectionsQuery = useAdminQuery<ConnectionsResponse>({
    key: statsKeys.connections(), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 30_000,
    request: async (fetcher, signal) => {
      try {
        return await adminJson<ConnectionsResponse>(
          fetcher, '/listeners/connections', undefined, signal,
        );
      } catch (error) {
        if (error instanceof AdminResponseError) {
          const detail = typeof error.body.error === 'string' ? error.body.error : null;
          return { error: detail || 'live connection detail unavailable' };
        }
        throw error;
      }
    },
  });

  // /system — per-container CPU/memory, 30s (it samples the Docker stats stream
  // for ~1s per container). Soft-fails; range-independent.
  const systemQuery = useAdminQuery<SystemResponse>({
    key: statsKeys.system(), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 30_000,
    request: (fetcher, signal) => adminJson(fetcher, '/system', undefined, signal),
  });

  const data = statsQuery.error instanceof StatsShapeError ? null : (statsQuery.data ?? null);
  const err = statsQuery.error ? errorMessage(statsQuery.error) : null;
  const listeners = listenersQuery.data ?? lastListeners;
  const audience = audienceQuery.data ?? lastAudience;
  const connections = connectionsQuery.data ?? null;
  const systemRes = systemQuery.data ?? null;

  const llm = data?.llm;
  const tts = data?.tts;
  const djLog = data?.djLog;
  const requests = data?.requests;

  const samples = listeners?.samples ?? [];
  const counts = samples.map(s => s.count);
  const lNow = listeners?.current ?? null;
  const lPeak = counts.length ? Math.max(...counts) : null;
  const lMin = counts.length ? Math.min(...counts) : null;
  const lAvg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : null;
  const rangeLabel = range === '10080' ? '7d' : '24h';

  // Same listener series as the trend chart, so it respects the range toggle.
  // Local time.
  const hourBuckets = bucketSamplesByHour(samples);

  const audSessions = audience?.sessions ?? null;
  const audReferrers = audience?.referrers ?? [];
  const audCountries = audience?.countries ?? [];

  const connErr = connections?.error ?? null;
  const connList = connections?.connections ?? [];
  const connCount = connections?.count ?? connList.length;
  const deviceGroups = groupConnectionsByDevice(connList);
  const connAvgSeconds = connList.length
    ? connList.reduce((a, c) => a + (c.connectedSeconds > 0 ? c.connectedSeconds : 0), 0) / connList.length
    : 0;

  const sysHost = systemRes?.host ?? null;
  const sysContainers = systemRes?.containers ?? [];

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="flex flex-wrap items-center gap-4 p-3.5">
          <Eyebrow className={err ? 'text-[var(--danger)]' : 'text-vermilion'}>
            ● {err ? 'down' : 'live'}
          </Eyebrow>
          <span className="caption">refresh · 5s</span>
          <span className="caption text-muted">
            rollups since boot · listeners durable
          </span>
          <span className="ml-auto">
            <Btn sm onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Btn>
          </span>
        </div>
      </section>

      {err && <ErrorState error={err} />}

      <Card
        title="Audience"
        sub={`listeners over the last ${rangeLabel}`}
        right={<Seg value={range} options={RANGE_OPTIONS} onChange={setRange} />}
      >
        <div className="grid gap-0">
          <MetricStrip>
            <StatCell label="Now" value={fmtInt(lNow)} accent />
            <StatCell label="Peak" value={fmtInt(lPeak)} />
            <StatCell label="Average" value={fmtAvg(lAvg)} />
            <StatCell label="Low" value={fmtInt(lMin)} last />
          </MetricStrip>
          <div className="p-3.5">
            {listeners == null ? (
              <div className="flex h-[130px] items-center justify-center">
                <Skeleton className="h-4 w-16" />
              </div>
            ) : (
              <ListenerChart samples={samples} />
            )}
          </div>
          <div className="border-t border-separator-soft p-3.5">
            <div className="caption mb-2">
              busiest hours
              <span className="text-muted"> · avg listeners by hour · your local time</span>
            </div>
            {listeners == null ? (
              <div className="flex h-[110px] items-center justify-center">
                <Skeleton className="h-4 w-16" />
              </div>
            ) : (
              <HourOfDayChart buckets={hourBuckets} />
            )}
          </div>
        </div>
      </Card>

      <Card
        title="Audience sources"
        sub={`where listeners came from · last ${rangeLabel}`}
      >
        <div className="grid gap-0">
          {/* Rendered independently of the durable beacon rollup below, so it
              still shows on a fresh boot with zero recorded sessions. No IPs
              here (unlike the Dash), only device class, counts and durations. */}
          <div className="border-b border-separator-strong p-3.5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <span className="caption">connected now · by device</span>
              <span className="caption text-muted">
                {connErr
                  ? 'live detail unavailable'
                  : connections == null
                    ? 'loading…'
                    : `${fmtInt(connCount)} listening${
                        connList.length ? ` · avg ${fmtConnected(connAvgSeconds)}` : ''
                      }`}
              </span>
            </div>
            {connErr ? (
              <span className="field-hint italic">{connErr}</span>
            ) : connections == null ? (
              <Skeleton className="h-4 w-16" />
            ) : deviceGroups.length === 0 ? (
              <span className="field-hint italic">nobody connected right now</span>
            ) : (
              <BarList
                max={deviceGroups[0]?.count || 1}
                rows={deviceGroups.map(g => ({
                  label: g.device,
                  count: g.count,
                  trailing: `${g.count} · ${fmtConnected(g.avgSeconds)}${
                    g.count > 1 ? ` · up to ${fmtConnected(g.maxSeconds)}` : ''
                  }`,
                }))}
              />
            )}
          </div>

          {audience == null ? (
            <div className="p-3.5">
              <Skeleton className="h-4 w-16" />
            </div>
          ) : (audSessions ?? 0) === 0 ? (
            <div className="p-3.5">
              <span className="field-hint italic">
                no sessions recorded yet, sources appear as listeners arrive
              </span>
            </div>
          ) : (
            <>
              <MetricStrip>
                <StatCell label="Sessions" value={fmtInt(audSessions)} accent
                  sub={`distinct, last ${rangeLabel}`} />
                <StatCell label="Sources" value={fmtInt(audReferrers.length)} />
                <StatCell label="Countries" value={fmtInt(audCountries.length)} last />
              </MetricStrip>

              <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-0">
                <div className="border-b border-separator-soft p-3.5 sm:border-r sm:border-b-0">
                  <div className="caption mb-2">top referrers</div>
                  {audReferrers.length ? (
                    <ScrollBox>
                      <BarList
                        rows={audReferrers.map(r => ({ label: r.source, count: r.count }))}
                        max={audReferrers[0]?.count || 1}
                      />
                    </ScrollBox>
                  ) : (
                    <span className="field-hint italic">none</span>
                  )}
                </div>
                <div className="p-3.5">
                  <div className="caption mb-2">top countries</div>
                  {audCountries.length ? (
                    <ScrollBox>
                      <BarList
                        rows={audCountries.map(c => ({ label: c.country, count: c.count }))}
                        max={audCountries[0]?.count || 1}
                      />
                    </ScrollBox>
                  ) : (
                    <span className="field-hint italic">none</span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </Card>

      {!data && !err && (
        <Card title="Stats">
          <span className="field-hint italic">connecting…</span>
        </Card>
      )}

      {data && llm && tts && djLog && requests && (
        <>
          <Card
            title="LLM usage"
            sub={`last ${llm.window} model calls`}
            right={
              (llm.provider || llm.activeModel) ? (
                <span className="flex items-center gap-1.5">
                  {llm.provider && <Pill>{llm.provider}</Pill>}
                  {llm.activeModel && <Pill tone="accent">{llm.activeModel}</Pill>}
                </span>
              ) : null
            }
          >
            {/* Durable per-UTC-day tally, so it shows regardless of the
                since-boot call count above, and only when a cap is set. */}
            {llm.budget?.enabled && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-separator-strong p-3.5">
                <span className="caption">
                  Daily token budget<span className="text-muted"> · resets 00:00 UTC</span>
                </span>
                <span className="flex items-center gap-2.5">
                  <span className={cn(
                    'mono-num text-[15px] font-bold',
                    llm.budget.mode === 'hard' ? 'text-[var(--danger)]'
                      : llm.budget.mode === 'soft' ? 'text-vermilion' : '',
                  )}>
                    {fmtTokens(llm.budget.usedToday)} / {fmtTokens(llm.budget.cap)}
                  </span>
                  <Pill tone={llm.budget.mode === 'normal' ? undefined : 'accent'}>
                    {llm.budget.mode}
                  </Pill>
                </span>
              </div>
            )}
            {llm.count === 0 ? (
              <span className="field-hint italic">
                no model calls recorded yet
              </span>
            ) : (
              <div className="grid gap-0">
                <MetricStrip>
                  <StatCell label="Calls" value={fmtInt(llm.count)}
                    sub={`${llm.ok} ok · ${llm.failed} failed`} />
                  <StatCell label="Success rate" value={fmtPct(llm.successRate)}
                    danger={llm.successRate != null && llm.successRate < 0.9} />
                  <StatCell label="Avg latency" value={fmtMs(llm.latency.avg)}
                    sub={`p50 ${fmtMs(llm.latency.p50)} · p95 ${fmtMs(llm.latency.p95)}`} />
                  <StatCell label="Tokens" value={fmtTokens(llm.tokens?.total)}
                    sub={llm.tokens
                      ? `${fmtTokens(llm.tokens.input)} in · ${fmtTokens(llm.tokens.output)} out`
                      : 'provider reports none'} />
                  <StatCell label="Agent runs" value={fmtInt(llm.agent.calls)} last
                    sub={llm.agent.calls
                      ? `${llm.agent.avgSteps} steps · ${llm.agent.avgTools} tools avg`
                      : 'none'} />
                </MetricStrip>

                <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-0">
                  <div className="border-b border-separator-soft p-3.5 sm:border-r sm:border-b-0">
                    <div className="caption mb-2">by call kind</div>
                    <Table<ByKindRow>
                      empty="No calls"
                      rows={llm.byKind}
                      cols={[
                        { key: 'kind', label: 'Kind', render: r => r.kind.replace(/^sdk\./, '') },
                        { key: 'count', label: 'Calls', align: 'right',
                          render: r => <span className="mono-num">{r.count}</span> },
                        { key: 'ok', label: 'OK', align: 'right',
                          render: r => <span className="mono-num">{r.ok}/{r.count}</span> },
                        { key: 'avgMs', label: 'Avg', align: 'right',
                          render: r => <span className="mono-num">{fmtMs(r.avgMs)}</span> },
                        { key: 'tokens', label: 'Tokens', align: 'right',
                          render: r => <span className="mono-num">{fmtTokens(r.tokens || null)}</span> },
                      ]}
                    />
                  </div>
                  <div className="p-3.5">
                    <div className="caption mb-2">by model</div>
                    <Table<ByModelRow>
                      empty="No calls"
                      rows={llm.byModel}
                      cols={[
                        { key: 'model', label: 'Model' },
                        { key: 'count', label: 'Calls', align: 'right',
                          render: r => <span className="mono-num">{r.count}</span> },
                        { key: 'tokens', label: 'Tokens', align: 'right',
                          render: r => <span className="mono-num">{fmtTokens(r.tokens || null)}</span> },
                      ]}
                    />
                  </div>
                </div>
              </div>
            )}
          </Card>

          <Card title="Voice / TTS usage" sub={`last ${tts.window} spoken segments`}>
            {tts.count === 0 ? (
              <span className="field-hint italic">
                no spoken segments recorded yet
              </span>
            ) : (
              <div className="grid gap-0">
                <MetricStrip>
                  <StatCell label="Segments" value={fmtInt(tts.count)}
                    sub={`${tts.ok} ok · ${tts.failed} failed`} />
                  <StatCell label="Avg latency" value={fmtMs(tts.latency.avg)}
                    sub={`p95 ${fmtMs(tts.latency.p95)}`} />
                  <StatCell label="Slowest" value={fmtMs(tts.latency.max)} />
                  <StatCell label="Fallbacks" value={fmtInt(tts.fellBack)}
                    danger={tts.fellBack > 0}
                    sub={`${fmtPct(tts.fallbackRate)} of calls`} />
                  <StatCell label="Characters" value={fmtTokens(tts.chars)} last
                    sub="voiced" />
                </MetricStrip>

                <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-0">
                  <div className="border-b border-separator-soft p-3.5 sm:border-r sm:border-b-0">
                    <div className="caption mb-2">by engine</div>
                    <Table<ByEngineRow>
                      empty="No segments"
                      rows={tts.byEngine}
                      cols={[
                        { key: 'engine', label: 'Engine' },
                        { key: 'count', label: 'Calls', align: 'right',
                          render: r => <span className="mono-num">{r.count}</span> },
                        { key: 'ok', label: 'OK', align: 'right',
                          render: r => <span className="mono-num">{r.ok}/{r.count}</span> },
                        { key: 'avgMs', label: 'Avg', align: 'right',
                          render: r => <span className="mono-num">{fmtMs(r.avgMs)}</span> },
                      ]}
                    />
                  </div>
                  <div className="p-3.5">
                    <div className="caption mb-2">by segment kind</div>
                    <Table<ByTtsKindRow>
                      empty="No segments"
                      rows={tts.byKind}
                      cols={[
                        { key: 'kind', label: 'Kind' },
                        { key: 'count', label: 'Calls', align: 'right',
                          render: r => <span className="mono-num">{r.count}</span> },
                        { key: 'avgMs', label: 'Avg', align: 'right',
                          render: r => <span className="mono-num">{fmtMs(r.avgMs)}</span> },
                      ]}
                    />
                  </div>
                </div>
              </div>
            )}
          </Card>

          <Card
            title="Requests"
            sub={`last ${requests.window} listener requests · full trace on the Dash`}
          >
            {requests.count === 0 ? (
              <span className="field-hint italic">
                no listener requests yet
              </span>
            ) : (
              <div className="grid gap-0">
                <MetricStrip>
                  <StatCell label="Requests" value={fmtInt(requests.count)}
                    sub={`${requests.resolved} ok · ${requests.failed} failed`} />
                  <StatCell label="Success rate" value={fmtPct(requests.successRate)}
                    danger={requests.successRate != null && requests.successRate < 0.8} />
                  <StatCell label="Avg resolve" value={fmtMs(requests.latency.avg)}
                    sub={`p95 ${fmtMs(requests.latency.p95)}`} />
                  <StatCell label="Artist misses" value={fmtInt(requests.artistMiss.count)} last
                    danger={requests.artistMiss.count > 0}
                    sub={`${fmtPct(requests.artistMiss.rate)} of requests`} />
                </MetricStrip>

                <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-0">
                  <div className="border-b border-separator-soft p-3.5 sm:border-r sm:border-b-0">
                    <div className="caption mb-2">by resolution path</div>
                    {requests.byPath.length ? (
                      <BarList
                        max={requests.byPath[0]?.count || 1}
                        rows={requests.byPath.map(r => ({
                          label: r.path,
                          count: r.count,
                          trailing: `${r.ok}/${r.count}`,
                        }))}
                      />
                    ) : (
                      <span className="field-hint italic">no paths recorded</span>
                    )}
                  </div>
                  <div className="grid gap-3.5 p-3.5">
                    <div>
                      <div className="caption mb-2">by pick source</div>
                      <ScrollBox>
                        <Table<ByPickSourceRow>
                          empty="No pick sources"
                          rows={requests.byPickSource}
                          cols={[
                            { key: 'source', label: 'Source' },
                            { key: 'count', label: 'Picks', align: 'right',
                              render: r => <span className="mono-num">{r.count}</span> },
                          ]}
                        />
                      </ScrollBox>
                    </div>
                    <div>
                      <div className="caption mb-2">top requesters</div>
                      <Table<TopRequesterRow>
                        empty="No requesters"
                        rows={requests.topRequesters}
                        cols={[
                          { key: 'requester', label: 'Listener' },
                          { key: 'count', label: 'Requests', align: 'right',
                            render: r => <span className="mono-num">{r.count}</span> },
                        ]}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Card>

          <Card title="DJ activity" sub={`${djLog.count} log events by kind`}>
            {!djLog.byKind.length ? (
              <span className="field-hint italic">
                no DJ-log events yet
              </span>
            ) : (
              <ScrollBox>
                <BarList
                  max={djLog.byKind[0]?.count || 1}
                  rows={djLog.byKind.map(r => ({ label: r.kind, count: r.count }))}
                />
              </ScrollBox>
            )}
          </Card>
        </>
      )}

      <Card
        title="System resources"
        sub="CPU + memory for the SUB/WAVE containers on this host"
      >
        {systemRes == null ? (
          <Skeleton className="h-4 w-16" />
        ) : (
          <div className="grid gap-0">
            <MetricStrip>
              <StatCell label="Host cores" value={fmtInt(sysHost?.cpus)} />
              <StatCell label="Load (1m)"
                value={sysHost ? sysHost.loadavg[0].toFixed(2) : '—'}
                danger={!!sysHost && sysHost.loadavg[0] > sysHost.cpus}
                sub={sysHost
                  ? `${sysHost.loadavg[1].toFixed(2)} · ${sysHost.loadavg[2].toFixed(2)} (5m · 15m)`
                  : undefined} />
              <StatCell label="Host memory" value={fmtBytes(sysHost?.memUsed)}
                sub={sysHost ? `of ${fmtBytes(sysHost.memTotal)}` : undefined} />
              <StatCell label="Containers" value={fmtInt(sysContainers.length)} last />
            </MetricStrip>
            <div className="p-3.5">
              {!systemRes.dockerAvailable ? (
                <span className="field-hint italic">
                  container stats unavailable — start the docker-socket-proxy
                  sidecar (docker compose up -d) to enable
                  {systemRes.dockerError ? ` · ${systemRes.dockerError}` : ''}
                </span>
              ) : sysContainers.length === 0 ? (
                <span className="field-hint italic">no containers reporting</span>
              ) : (
                <ScrollBox>
                  <Table<ContainerUsage>
                    empty="No containers"
                    rows={sysContainers}
                    cols={[
                      { key: 'service', label: 'Service' },
                      { key: 'cpuPct', label: 'CPU', align: 'right',
                        render: r => <span className="mono-num">{r.cpuPct.toFixed(1)}%</span> },
                      { key: 'memUsed', label: 'Memory', align: 'right',
                        render: r => <span className="mono-num">{fmtBytes(r.memUsed)}</span> },
                      { key: 'memPct', label: 'Mem %', align: 'right',
                        render: r => <span className="mono-num">{r.memPct.toFixed(1)}%</span> },
                    ]}
                  />
                </ScrollBox>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
