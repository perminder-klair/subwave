'use client';

// Who's listening: the audience over the chosen range, when it listens, where
// it came from and who is connected now. The listener line is drawn as steps,
// because a count holds until it changes, and breaks where the controller could
// not read (a gap in the per-minute history is an outage, not zero listeners).

import type { ReactNode } from 'react';
import { useId, useMemo, useRef, useState } from 'react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import { fmtConnected } from '../../../lib/clientLabel';
import {
  bucketSamplesByHour,
  groupConnectionsByDevice,
  splitAtGaps,
  timedSamples,
  timeTicks,
  type HourBucket,
  type ListenerSample,
} from '../../../lib/audienceStats';
import { countryName } from '../dash/types';
import { Seg } from '../ui';
import { ScrollArea } from '../../ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Bar, Cell, CellGrid, DurationBar, Hint, LABEL, MetricCell, NOTE, Panel, SUB, Section } from './parts';
import { fmtAvg, fmtInt, fmtShare } from './format';
import type { AudienceResponse, ConnectionsResponse } from './types';

export const RANGE_OPTIONS = [
  { id: '1440', label: '24h' },
  { id: '10080', label: '7d' },
];

const LIST_LIMIT = 6;
const HEADROOM = 1.15;

// An HTML overlay placed by percentage of its positioned parent.
function Pos({ left, top, className, children }: {
  left?: number;
  top?: number;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, {
    left: left == null ? null : `${left}%`,
    top: top == null ? null : `${top}%`,
  });
  return <span ref={ref} className={cn('pointer-events-none absolute', className)}>{children}</span>;
}

// The viewBox is 1000×200 stretched to the box (preserveAspectRatio=none), so
// strokes are non-scaling and every word is HTML over the drawing.
function StepChart({ samples }: { samples: ListenerSample[] }) {
  const g = useMemo(() => {
    const series = timedSamples(samples);
    const t0 = series[0]?.ms ?? 0;
    const span = Math.max(1, (series[series.length - 1]?.ms ?? 0) - t0);
    const peak = series.reduce((m, s) => Math.max(m, s.count), 0);
    const max = peak > 0 ? peak * HEADROOM : 1;
    const x = (ms: number) => (((ms - t0) / span) * 1000).toFixed(1);
    const y = (c: number) => (200 - (c / max) * 200).toFixed(1);
    const lines: string[] = [];
    const areas: string[] = [];
    for (const run of splitAtGaps(series)) {
      const first = run[0];
      if (!first) continue;
      let d = `M${x(first.ms)},${y(first.count)}`;
      for (const p of run.slice(1)) d += ` H${x(p.ms)} V${y(p.count)}`;
      // A lone minute between two gaps still gets a sliver.
      if (run.length === 1) d += ` H${x(first.ms + 60_000)}`;
      lines.push(d);
      areas.push(`${d} V200 H${x(first.ms)} Z`);
    }
    return { series, t0, span, peak, max, lines, areas, ticks: timeTicks(t0, t0 + span) };
  }, [samples]);

  if (g.series.length < 2) {
    return (
      <div className="flex h-[170px] items-center justify-center">
        <Hint>collecting listener history…</Hint>
      </div>
    );
  }
  const peakTop = (1 - g.peak / g.max) * 100;
  return (
    <div className="grid gap-2">
      <div className="relative h-[170px]" role="img" aria-label={`Listeners over time, peaking at ${g.peak}`}>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" className="block size-full" aria-hidden="true">
          {g.areas.map((d, i) => (
            <path key={`a${i}`} d={d} className="fill-[color-mix(in_oklab,var(--accent)_14%,transparent)] stroke-none" />
          ))}
          {g.lines.map((d, i) => (
            <path
              key={`l${i}`}
              d={d}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-[var(--accent)] stroke-[1.5] [stroke-linejoin:round]"
            />
          ))}
        </svg>
        {g.peak > 0 && (
          <>
            <Pos top={peakTop} className="inset-x-0 border-t border-dashed border-ink" />
            <Pos
              top={peakTop}
              className="right-0 -translate-y-[120%] bg-[var(--card-bg)] pl-1.5 font-mono text-[10px] font-bold tracking-[0.16em] uppercase"
            >
              peak {g.peak}
            </Pos>
          </>
        )}
      </div>
      <div className="relative h-4 font-mono text-[10px] tracking-[0.12em] text-muted uppercase" aria-hidden="true">
        {g.ticks.map(t => (
          <Pos key={t.ms} left={t.frac * 100} className="-translate-x-1/2 whitespace-nowrap">{t.label}</Pos>
        ))}
        <span className="absolute right-0">now</span>
      </div>
    </div>
  );
}

const EQ_CELLS = 10;
const pad = (h: number) => String(h).padStart(2, '0');

function busiestHour(buckets: HourBucket[]): HourBucket | null {
  let best: HourBucket | null = null;
  for (const b of buckets) if (b.samples > 0 && b.avg > 0 && (!best || b.avg > best.avg)) best = b;
  return best;
}

// Average listeners by local hour as a graphic-EQ: ten LED cells a column, the
// top two lit in the accent like a meter's red zone.
function HourEq({ buckets }: { buckets: HourBucket[] }) {
  if (!buckets.some(b => b.samples > 0)) {
    return (
      <div className="flex h-[110px] items-center justify-center">
        <Hint>collecting hourly history…</Hint>
      </div>
    );
  }
  const top = busiestHour(buckets);
  const max = top?.avg || 1;
  return (
    <>
      <div className="grid h-[110px] grid-cols-24 gap-[3px] sm:gap-1">
        {buckets.map(b => {
          const lit = Math.max(1, Math.round((b.avg / max) * EQ_CELLS));
          return (
            <div
              key={b.hour}
              title={b.samples ? `${pad(b.hour)}:00 · avg ${fmtAvg(b.avg)} · peak ${b.peak}` : `${pad(b.hour)}:00 · no data`}
              className="flex h-full flex-col-reverse gap-0.5"
            >
              {Array.from({ length: EQ_CELLS }, (_, k) => (
                <span
                  key={k}
                  className={cn(
                    'flex-1',
                    k >= lit ? 'bg-[var(--separator-strong)]' : k >= EQ_CELLS - 2 ? 'bg-vermilion' : 'bg-ink',
                  )}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-24 gap-[3px] sm:gap-1" aria-hidden="true">
        {buckets.map(b => (
          <span
            key={b.hour}
            className={cn('text-center font-mono text-[9px]', b.hour === top?.hour ? 'text-vermilion' : 'text-muted')}
          >
            {b.hour % 3 === 0 || b.hour === top?.hour ? pad(b.hour) : ''}
          </span>
        ))}
      </div>
    </>
  );
}

function ShareHead({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className={LABEL}>{title}</span>
      <span className={NOTE}>{note}</span>
    </div>
  );
}

// The top of a long list, with the rest a click away. Opened, the list scrolls
// in place so a 40-row tail does not push the rest of the page down.
function ExpandableList<R>({ rows, noun, render }: {
  rows: R[];
  noun: string;
  render: (row: R, i: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const extra = rows.length - LIST_LIMIT;
  const body = (open ? rows : rows.slice(0, LIST_LIMIT)).map(render);
  return (
    <>
      {open ? (
        <ScrollArea className="max-h-72">
          <div id={id} className="grid gap-2.5 pr-3">{body}</div>
        </ScrollArea>
      ) : (
        <div id={id} className="grid gap-2.5">{body}</div>
      )}
      {extra > 0 && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(o => !o)}
          className={cn(SUB, 'w-fit cursor-pointer underline-offset-[3px] hover:text-ink hover:underline')}
        >
          {open ? 'show the top 6' : `+ ${extra} more ${noun}`}
        </button>
      )}
    </>
  );
}

function Referrers({ rows, sessions }: { rows: { source: string; count: number }[]; sessions: number }) {
  const max = rows[0]?.count || 1;
  return (
    <Cell className="gap-2.5 px-[18px] py-4">
      <ShareHead title="Top referrers" note="share of sessions" />
      {rows.length === 0 ? <Hint>none yet</Hint> : (
        <ExpandableList
          rows={rows}
          noun="sources"
          render={(r, i) => (
            <div key={r.source} className="grid grid-cols-[minmax(0,104px)_minmax(0,1fr)_40px_34px] items-center gap-2.5 text-[12px]">
              <span className="truncate" title={r.source}>{r.source}</span>
              <Bar frac={r.count / max} lead={i === 0} />
              <span className="text-right font-mono font-bold tabular-nums">{fmtInt(r.count)}</span>
              <span className="text-right font-mono text-[11px] text-muted">{fmtShare(r.count, sessions)}</span>
            </div>
          )}
        />
      )}
    </Cell>
  );
}

function Countries({ rows, sessions }: { rows: { country: string; count: number }[]; sessions: number }) {
  const max = rows[0]?.count || 1;
  return (
    <Cell className="gap-2.5 px-[18px] py-4">
      <ShareHead title="Top countries" note="share of sessions" />
      {rows.length === 0 ? <Hint>none yet</Hint> : (
        <ExpandableList
          rows={rows}
          noun="countries"
          render={(r, i) => (
            <div
              key={r.country}
              className="grid grid-cols-[28px_minmax(0,92px)_minmax(0,1fr)_40px_34px] items-center gap-2.5 text-[12px]"
            >
              <span className="border border-ink py-px text-center font-mono text-[10px] font-bold">{r.country}</span>
              <span className="truncate">{countryName(r.country)}</span>
              <Bar frac={r.count / max} lead={i === 0} />
              <span className="text-right font-mono font-bold tabular-nums">{fmtInt(r.count)}</span>
              <span className="text-right font-mono text-[11px] text-muted">{fmtShare(r.count, sessions)}</span>
            </div>
          )}
        />
      )}
    </Cell>
  );
}

function ConnectedNow({ connections }: { connections: ConnectionsResponse | null }) {
  const list = connections?.connections ?? [];
  const groups = groupConnectionsByDevice(list);
  const count = connections?.count ?? list.length;
  const avgSeconds = list.length
    ? list.reduce((a, c) => a + (c.connectedSeconds > 0 ? c.connectedSeconds : 0), 0) / list.length
    : 0;
  const longest = groups.reduce((m, g) => Math.max(m, g.maxSeconds), 0);
  return (
    <Cell className="gap-2.5 px-[18px] py-4">
      <ShareHead
        title="Connected now"
        note={connections?.error
          ? 'live detail unavailable'
          : connections == null
            ? 'loading…'
            : `${fmtInt(count)} listening${list.length ? ` · avg ${fmtConnected(avgSeconds)}` : ''}`}
      />
      {connections?.error ? (
        <Hint>{connections.error}</Hint>
      ) : connections == null ? (
        <Skeleton className="h-4 w-24" />
      ) : groups.length === 0 ? (
        <Hint>nobody connected right now</Hint>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(40px,96px)_auto] items-center gap-x-3 gap-y-2 text-[12px]">
          <span className="sr-only">device, listeners, time connected</span>
          <span aria-hidden="true" className="col-span-4 -mb-1 flex justify-end gap-1 font-mono text-[10px] text-muted">
            <span className="inline-block h-2.5 w-0.5 self-center bg-vermilion" /> average · bar runs to the longest
          </span>
          {groups.map(g => (
            <div key={g.device} className="contents">
              <span className="truncate">{g.device}</span>
              <span className="font-mono font-bold tabular-nums">{g.count}</span>
              <DurationBar avg={g.avgSeconds} max={g.maxSeconds} scale={longest} />
              <span className="text-right font-mono text-[11px] whitespace-nowrap text-muted">
                {fmtConnected(g.avgSeconds)}
                {g.count > 1 && ` · up to ${fmtConnected(g.maxSeconds)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </Cell>
  );
}

export function Listening({ range, onRange, rangeLabel, samples, listenersLoaded, audience, connections }: {
  range: string;
  onRange: (id: string) => void;
  rangeLabel: string;
  samples: ListenerSample[];
  listenersLoaded: boolean;
  audience: AudienceResponse | null;
  connections: ConnectionsResponse | null;
}) {
  const counts = samples.map(s => s.count);
  const peak = counts.length ? Math.max(...counts) : null;
  const low = counts.length ? Math.min(...counts) : null;
  const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : null;
  const sessions = audience?.sessions ?? 0;
  const referrers = audience?.referrers ?? [];
  const countries = audience?.countries ?? [];
  // Same series as the chart, so it follows the range toggle. Local time.
  const hours = bucketSamplesByHour(samples);
  const top = busiestHour(hours);
  return (
    <Section
      title="Who's listening"
      id="stats-audience"
      sub={`audience and sources · last ${rangeLabel}`}
      right={<Seg value={range} options={RANGE_OPTIONS} onChange={onRange} aria-label="Range" />}
    >
      <Panel>
        <CellGrid min={140} className="border-b border-ink">
          <MetricCell label="Peak" value={fmtInt(peak)} />
          <MetricCell label="Average" value={fmtAvg(avg)} />
          <MetricCell label="Low" value={fmtInt(low)} />
          <MetricCell label="Sessions" value={audience ? fmtInt(sessions) : '—'} tone="accent" />
          <MetricCell label="Sources" value={audience ? fmtInt(referrers.length) : '—'} />
          <MetricCell label="Countries" value={audience ? fmtInt(countries.length) : '—'} />
        </CellGrid>

        <div className="px-[18px] pt-[22px] pb-3.5">
          {listenersLoaded ? <StepChart samples={samples} /> : <Skeleton className="h-[170px] w-full" />}
        </div>

        <div className="grid gap-3 border-t border-separator-strong px-[18px] pt-4 pb-[18px]">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className={LABEL}>Busiest hours</span>
            <span className={NOTE}>
              avg listeners by hour · your local time{top ? ` · busiest ${pad(top.hour)}:00` : ''}
            </span>
          </div>
          {listenersLoaded ? <HourEq buckets={hours} /> : <Skeleton className="h-[110px] w-full" />}
        </div>

        <CellGrid min={280} className="border-t border-ink">
          {audience == null ? (
            <Cell className="px-[18px] py-4"><Skeleton className="h-24 w-full" /></Cell>
          ) : (
            <>
              <Referrers rows={referrers} sessions={sessions} />
              <Countries rows={countries} sessions={sessions} />
            </>
          )}
          <ConnectedNow connections={connections} />
        </CellGrid>
      </Panel>
    </Section>
  );
}
