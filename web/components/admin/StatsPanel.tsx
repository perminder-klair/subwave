'use client';

/* Admin Stats page — the station's rollup + trend dashboard.

   Two data sources, two cadences:
   - GET /stats (5s) aggregates the in-memory LLM / TTS / DJ-log / request rings
     (since boot, lost on restart by design — the raw per-call lists live on
     /debug, and the per-request trace lives on the Dash).
   - GET /listeners (30s) returns the durable listener time-series persisted to
     state/listeners.jsonl (24h–7d), drawn as the Audience trend chart.

   The Dash is the live ops console (3s now-playing, live connections, per-request
   review); this page is the aggregate/trend complement. */

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { V3Alert } from '../ui/alert';
import { Card, Btn, Pill, Eyebrow, Seg } from './ui';
import { cn } from '../../lib/cn';

// --- types --------------------------------------------------------------

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

// --- formatters ---------------------------------------------------------

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

// --- small building blocks ---------------------------------------------

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
  return (
    <div
      ref={ref}
      className="strip-mobile grid border-b border-separator-strong"
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
    <span className="inline-block h-1.5 w-14 overflow-hidden rounded-[2px] bg-separator-soft align-middle">
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
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          {cols.map(c => (
            <th
              key={c.key}
              className={cn(
                'caption border-b border-separator-strong px-2 py-1 whitespace-nowrap',
                // Sticky so the header stays put when the table is wrapped in a
                // ScrollBox; the card-bg masks rows scrolling underneath.
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
  );
}

// Horizontal bar list — a label, a proportional bar, a trailing figure. Used
// for the DJ-activity and request-by-path breakdowns. `max` anchors the widest
// bar to 100%.
interface BarRow {
  label: string;
  count: number;
  trailing?: ReactNode;
}

function BarList({ rows, max }: { rows: BarRow[]; max: number }) {
  return (
    <div className="grid gap-1.5">
      {rows.map(r => (
        <div key={r.label} className="flex items-center gap-2.5 text-[12px]">
          <span className="w-[110px] truncate text-muted" title={r.label}>{r.label}</span>
          <Bar frac={r.count / (max || 1)} />
          <span className="mono-num font-bold">{r.trailing ?? r.count}</span>
        </div>
      ))}
    </div>
  );
}

// Caps a breakdown list/table to a scrollable area so a long tail (e.g. 40
// referrers or countries) can't stretch the card down the page. Short lists are
// untouched — the scrollbar only appears once content exceeds the cap. Uses the
// house ink-tinted scrollbar (.v3-scroll, globals.css); tables wrapped here keep
// their header visible via the sticky <thead> in <Table>.
function ScrollBox({ children }: { children: ReactNode }) {
  return <div className="v3-scroll max-h-[260px] overflow-y-auto">{children}</div>;
}

// --- listener trend chart ----------------------------------------------

// Hand-rolled SVG area chart for the listener time-series — same no-dependency
// house style as the StationHeader gauge and the Wave bars. The viewBox is a
// fixed 100×100 unit box stretched to the container (preserveAspectRatio=none);
// strokes use vector-effect=non-scaling-stroke so they stay an even width
// regardless of the stretch. Labels live in the metric strip below, not in the
// SVG, so nothing gets distorted by the stretch.
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
          stroke="var(--ink)"
          strokeWidth={1}
          strokeDasharray="2 3"
          opacity={0.18}
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

const RANGE_OPTIONS = [
  { id: '1440', label: '24h' },
  { id: '10080', label: '7d' },
];

// --- panel --------------------------------------------------------------

export default function StatsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [listeners, setListeners] = useState<ListenersResponse | null>(null);
  const [audience, setAudience] = useState<AudienceResponse | null>(null);
  const [systemRes, setSystemRes] = useState<SystemResponse | null>(null);
  const [range, setRange] = useState('1440'); // minutes — 24h default

  // /stats — usage rollups, 5s.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      if (paused) return;
      try {
        const r = await adminFetch('/stats');
        if (r.status === 401) {
          if (!cancelled) setData(null);
          return;
        }
        const j = (await r.json()) as StatsResponse;
        if (cancelled) return;
        if (!j || typeof j !== 'object' || !j.llm) {
          setErr(j?.error || 'unexpected response shape from /stats');
          setData(null);
        } else {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [paused, needsAuth, hydrated, adminFetch]);

  // /listeners — durable time-series for the Audience chart, 30s (heavier: it
  // reads the JSONL history file, and the series moves slowly). Soft-fails: a
  // miss leaves the last reading in place rather than erroring the page.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      if (paused) return;
      try {
        const r = await adminFetch(`/listeners?sinceMinutes=${range}`);
        if (r.status === 401) {
          if (!cancelled) setListeners(null);
          return;
        }
        const j = (await r.json()) as ListenersResponse;
        if (!cancelled && r.ok) setListeners(j);
      } catch {
        /* leave last reading in place */
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [paused, needsAuth, hydrated, adminFetch, range]);

  // /audience — durable referral/geo rollup, 30s, soft-fail (same cadence and
  // failure handling as /listeners).
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      if (paused) return;
      try {
        const r = await adminFetch(`/audience?sinceMinutes=${range}`);
        if (r.status === 401) {
          if (!cancelled) setAudience(null);
          return;
        }
        const j = (await r.json()) as AudienceResponse;
        if (!cancelled && r.ok) setAudience(j);
      } catch {
        /* leave last reading in place */
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [paused, needsAuth, hydrated, adminFetch, range]);

  // /system — per-container CPU/memory, 30s (it samples the Docker stats stream
  // for ~1s per container, so it's heavier than /stats). Soft-fails like the
  // others. Range-independent — always "right now".
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      if (paused) return;
      try {
        const r = await adminFetch('/system');
        if (r.status === 401) {
          if (!cancelled) setSystemRes(null);
          return;
        }
        const j = (await r.json()) as SystemResponse;
        if (!cancelled && r.ok) setSystemRes(j);
      } catch {
        /* leave last reading in place */
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [paused, needsAuth, hydrated, adminFetch]);

  const llm = data?.llm;
  const tts = data?.tts;
  const djLog = data?.djLog;
  const requests = data?.requests;

  // Audience figures derived from the listener series + the live count.
  const samples = listeners?.samples ?? [];
  const counts = samples.map(s => s.count);
  const lNow = listeners?.current ?? null;
  const lPeak = counts.length ? Math.max(...counts) : null;
  const lMin = counts.length ? Math.min(...counts) : null;
  const lAvg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : null;
  const rangeLabel = range === '10080' ? '7d' : '24h';

  // Audience-source rollup (referrers / countries / distinct sessions).
  const audSessions = audience?.sessions ?? null;
  const audReferrers = audience?.referrers ?? [];
  const audCountries = audience?.countries ?? [];

  // System resources (container CPU/mem + host totals).
  const sysHost = systemRes?.host ?? null;
  const sysContainers = systemRes?.containers ?? [];

  return (
    <div className="grid gap-4">
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
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

      {err && <V3Alert tone="error" title="controller error">{err}</V3Alert>}

      {/* ── AUDIENCE ────────────────────────────────────────────────────── */}
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
                <span className="field-hint italic">loading…</span>
              </div>
            ) : (
              <ListenerChart samples={samples} />
            )}
          </div>
        </div>
      </Card>

      {/* ── AUDIENCE SOURCES ─────────────────────────────────────────────── */}
      <Card
        title="Audience sources"
        sub={`where listeners came from · last ${rangeLabel}`}
      >
        {audience == null ? (
          <span className="field-hint italic">loading…</span>
        ) : (audSessions ?? 0) === 0 ? (
          <span className="field-hint italic">
            no sessions recorded yet, sources appear as listeners arrive
          </span>
        ) : (
          <div className="grid gap-0">
            <MetricStrip>
              <StatCell label="Sessions" value={fmtInt(audSessions)} accent
                sub={`distinct, last ${rangeLabel}`} />
              <StatCell label="Sources" value={fmtInt(audReferrers.length)} />
              <StatCell label="Countries" value={fmtInt(audCountries.length)} last />
            </MetricStrip>

            <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-0">
              <div className="border-r border-separator-soft p-3.5">
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
          </div>
        )}
      </Card>

      {!data && !err && (
        <Card title="Stats">
          <span className="field-hint italic">connecting…</span>
        </Card>
      )}

      {data && llm && tts && djLog && requests && (
        <>
          {/* ── LLM USAGE ─────────────────────────────────────────────── */}
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
                  <div className="border-r border-separator-soft p-3.5">
                    <div className="caption mb-2">by call kind</div>
                    <Table<ByKindRow>
                      empty="no calls"
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
                      empty="no calls"
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

          {/* ── TTS USAGE ─────────────────────────────────────────────── */}
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
                  <div className="border-r border-separator-soft p-3.5">
                    <div className="caption mb-2">by engine</div>
                    <Table<ByEngineRow>
                      empty="no segments"
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
                      empty="no segments"
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

          {/* ── REQUESTS ──────────────────────────────────────────────── */}
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
                  <div className="border-r border-separator-soft p-3.5">
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
                      <Table<ByPickSourceRow>
                        empty="no pick sources"
                        rows={requests.byPickSource}
                        cols={[
                          { key: 'source', label: 'Source' },
                          { key: 'count', label: 'Picks', align: 'right',
                            render: r => <span className="mono-num">{r.count}</span> },
                        ]}
                      />
                    </div>
                    <div>
                      <div className="caption mb-2">top requesters</div>
                      <Table<TopRequesterRow>
                        empty="no requesters"
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

          {/* ── DJ ACTIVITY ───────────────────────────────────────────── */}
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

      {/* ── SYSTEM RESOURCES ──────────────────────────────────────────── */}
      <Card
        title="System resources"
        sub="CPU + memory for the SUB/WAVE containers on this host"
      >
        {systemRes == null ? (
          <span className="field-hint italic">loading…</span>
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
                  container stats unavailable, mount /var/run/docker.sock (read-only)
                  into the controller to enable
                </span>
              ) : sysContainers.length === 0 ? (
                <span className="field-hint italic">no containers reporting</span>
              ) : (
                <ScrollBox>
                  <Table<ContainerUsage>
                    empty="no containers"
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
