'use client';

// At a glance: is anyone listening, is the station healthy, and how much of
// today's token allowance is gone, before any tables. The VU meter and the
// budget dial are SVG drawn in a uniformly scaled viewBox; the figures a reader
// needs are also printed in HTML beside them.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import {
  llmHealth,
  memoryHealth,
  requestsHealth,
  voiceFailureHealth,
  voiceFallbackHealth,
  type Health,
} from '../../../lib/statsHealth';
import { Skeleton } from '@/components/ui/skeleton';
import { Cell, CellGrid, LABEL, Lamp, NOTE, Panel, SUB, Section, TONE_TEXT, healthTone } from './parts';
import { fmtAvg, fmtBytes, fmtInt, fmtPct, fmtSec, fmtTokens, fmtUsd } from './format';
import type { HostUsage, LlmStats, RequestsStats, TtsStats } from './types';

// The needle swings up from rest once, after mount, like a meter powering on.
function useSwung(): boolean {
  const [swung, setSwung] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSwung(true), 300);
    return () => clearTimeout(t);
  }, []);
  return swung;
}

const NICE_STEPS = [5, 10, 25, 50, 100, 250, 500, 1000];

// A scale with three or more major divisions that clears the peak.
function vuScale(peak: number): { max: number; major: number } {
  const major = NICE_STEPS.find(s => s >= (peak + 1) / 3) ?? 1000;
  return { major, max: Math.max(3 * major, major * Math.ceil((peak + 1) / major)) };
}

const VU = { cx: 150, cy: 150, r: 112, sweep: 48 };

function VuMeter({ now, peak }: { now: number; peak: number }) {
  const swung = useSwung();
  const needle = useRef<SVGGElement>(null);
  const { max, major } = vuScale(peak);
  const unit = max / 15; // the drawing's offsets were set on a 0–15 scale
  const angle = (v: number) => -VU.sweep + (2 * VU.sweep * Math.min(v, max)) / max;
  const pt = (v: number, rad: number): [number, number] => {
    const a = (angle(v) * Math.PI) / 180;
    return [VU.cx + rad * Math.sin(a), VU.cy - rad * Math.cos(a)];
  };
  const xy = ([x, y]: [number, number]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const arc = (v0: number, v1: number, rad: number) => `M${xy(pt(v0, rad))} A${rad},${rad} 0 0 1 ${xy(pt(v1, rad))}`;

  let ticks = '';
  const minor = major / 5;
  for (let v = 0; v <= max + 1e-9; v += minor) {
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-9;
    ticks += `M${xy(pt(v, VU.r))} L${xy(pt(v, VU.r - (isMajor ? 14 : 7)))} `;
  }
  const majors: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += major) majors.push(Math.round(v));
  const peakLabel = pt(Math.min(peak, max) + (peak >= max - 2 * unit ? -2.2 : 1.6) * unit, VU.r - 30);

  useDynamicStyle(needle, { transform: `rotate(${swung ? angle(now) : -VU.sweep}deg)` });

  return (
    <div className="border border-ink px-2.5 pt-2.5">
      <svg viewBox="0 0 300 165" className="block h-auto w-full" aria-hidden="true">
        <path d={arc(0, max, VU.r)} className="fill-none stroke-[var(--ink)] stroke-1" />
        {peak > 0 && (
          <path d={arc(Math.min(peak, max - 0.3 * unit), max, VU.r + 5)} className="fill-none stroke-[var(--accent)] stroke-[6]" />
        )}
        <path d={ticks} className="fill-none stroke-[var(--ink)] stroke-[1.2]" />
        {majors.map((v, i) => {
          const [x, y] = pt(v, VU.r + 17);
          return (
            <text
              key={v}
              x={x}
              y={y}
              textAnchor="middle"
              className={cn('font-mono text-[11px] font-bold', i === majors.length - 1 ? 'fill-[var(--accent)]' : 'fill-[var(--ink)]')}
            >
              {v}
            </text>
          );
        })}
        {peak > 0 && (
          <text
            x={peakLabel[0]}
            y={peakLabel[1]}
            textAnchor="middle"
            className="fill-[var(--accent)] font-mono text-[8px] font-bold tracking-[0.12em]"
          >
            PEAK {peak}
          </text>
        )}
        <text x="150" y="118" textAnchor="middle" className="fill-[var(--muted)] font-mono text-[9px] font-bold tracking-[0.36em]">
          LISTENERS
        </text>
        <g
          ref={needle}
          className="origin-[150px_150px] transition-transform duration-[1600ms] ease-[cubic-bezier(.2,1.5,.4,1)] [transform-box:view-box] motion-reduce:transition-none"
        >
          <line x1="150" y1="150" x2="150" y2="40" className="stroke-[var(--ink)] stroke-[1.6]" />
        </g>
        <rect x="124" y="146" width="52" height="19" className="fill-[var(--ink)]" />
      </svg>
    </div>
  );
}

function ListenersTile({ now, peak, avg, low, rangeLabel, loaded }: {
  now: number | null;
  peak: number | null;
  avg: number | null;
  low: number | null;
  rangeLabel: string;
  loaded: boolean;
}) {
  return (
    <Cell className="gap-3.5 border-ink p-[18px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className={LABEL}>Listeners</span>
        <span className={NOTE}>on air now</span>
      </div>
      <VuMeter now={now ?? 0} peak={peak ?? 0} />
      <div className="flex flex-wrap items-baseline gap-3.5">
        {loaded ? (
          <span className={cn('font-mono text-[44px] leading-none font-bold tabular-nums', now == null ? 'text-muted' : 'text-vermilion')}>
            {fmtInt(now)}
          </span>
        ) : (
          <Skeleton className="h-10 w-12" />
        )}
        <span className={SUB}>
          peak {fmtInt(peak)} · avg {fmtAvg(avg)} · low {fmtInt(low)} · {rangeLabel}
        </span>
      </div>
    </Cell>
  );
}

interface HealthRow {
  name: string;
  sub: string;
  value: string;
  health: Health;
  // Where to look when it isn't ok; `where` names it for the hover title.
  href: string;
  where: string;
}

const FLAG: Record<Health, string> = { ok: 'ok', warn: 'check', bad: 'alert', idle: 'idle' };

const worse = (a: Health, b: Health): Health => {
  const rank: Record<Health, number> = { idle: 0, ok: 1, warn: 2, bad: 3 };
  return rank[b] > rank[a] ? b : a;
};

function healthRows(llm: LlmStats, tts: TtsStats, requests: RequestsStats, host: HostUsage | null): HealthRow[] {
  const rows: HealthRow[] = [
    {
      name: 'DJ brain',
      sub: `llm · ${fmtInt(llm.count)} calls · ${fmtPct(llm.successRate)} ok`,
      value: fmtSec(llm.latency.avg),
      health: llmHealth(llm).health,
      href: '/admin/debug#llm-recent-calls',
      where: 'the recent LLM calls on Debug',
    },
    {
      name: 'Voice',
      sub: `tts · ${fmtInt(tts.count)} segments · ${fmtInt(tts.fellBack)} fallbacks`,
      value: fmtSec(tts.latency.avg),
      health: worse(voiceFailureHealth(tts).health, voiceFallbackHealth(tts).health),
      href: '/admin/debug#tts-routing',
      where: 'TTS routing and recent calls on Debug',
    },
    {
      name: 'Requests',
      sub: `${fmtInt(requests.count)} · ${fmtPct(requests.successRate)} resolved`,
      value: fmtSec(requests.latency.avg),
      health: requestsHealth(requests).health,
      href: '/admin/dash#requests',
      where: 'the request trace on the Dash',
    },
  ];
  if (host) {
    rows.push({
      name: 'Host',
      sub: `memory ${fmtBytes(host.memUsed)} of ${fmtBytes(host.memTotal)}`,
      value: fmtPct(host.memTotal ? host.memUsed / host.memTotal : null),
      health: memoryHealth(host).health,
      href: '#stats-rack',
      where: 'the rack below',
    });
  }
  return rows;
}

function HealthTile({ rows, statsDown }: { rows: HealthRow[] | null; statsDown: boolean }) {
  const toCheck = rows?.filter(r => r.health === 'warn' || r.health === 'bad').length ?? 0;
  return (
    <Cell className="gap-1.5 border-ink p-[18px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className={LABEL}>Health</span>
        {rows && (
          <span className={cn(NOTE, toCheck && 'text-vermilion')}>{toCheck ? `${toCheck} to check` : 'all clear'}</span>
        )}
      </div>
      {!rows ? (
        statsDown ? (
          <p className={cn(SUB, 'm-0 py-3')}>cannot reach the controller</p>
        ) : (
          <div className="grid gap-3 py-3">
            {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        )
      ) : (
        <ul className="m-0 grid list-none p-0">
          {rows.map(r => (
            <li key={r.name} className="border-b border-separator-strong">
              <Link
                href={r.href}
                title={`Open ${r.where}`}
                className="group grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-3 py-[13px] text-ink no-underline hover:bg-[color-mix(in_oklab,var(--ink)_4%,transparent)]"
              >
                <Lamp health={r.health} />
                <span className="grid min-w-0 gap-[3px]">
                  <span className="text-[14px] font-semibold underline-offset-[3px] group-hover:underline">
                    {r.name}
                    <span aria-hidden="true" className="ml-1.5 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">→</span>
                  </span>
                  <span className={cn(SUB, 'truncate')}>{r.sub}</span>
                </span>
                <span className="grid justify-items-end gap-[3px]">
                  <span className={cn('font-mono text-[15px] font-bold tabular-nums', TONE_TEXT[healthTone(r.health)])}>{r.value}</span>
                  <span
                    className={cn(
                      'font-mono text-[9px] font-bold tracking-[0.2em] uppercase',
                      r.health === 'ok' || r.health === 'idle' ? 'text-muted' : TONE_TEXT[healthTone(r.health)],
                    )}
                  >
                    {FLAG[r.health]}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Cell>
  );
}

const DIAL = { cx: 80, cy: 80 };

// A 270° arc from bottom-left round to bottom-right, `f0`–`f1` of the way along.
function dialArc(f0: number, f1: number, rad: number): string {
  const p = (f: number) => {
    const a = ((135 + 270 * f) * Math.PI) / 180;
    return `${(DIAL.cx + rad * Math.cos(a)).toFixed(1)},${(DIAL.cy + rad * Math.sin(a)).toFixed(1)}`;
  };
  return `M${p(f0)} A${rad},${rad} 0 ${(f1 - f0) * 270 > 180 ? 1 : 0} 1 ${p(f1)}`;
}

function BudgetDial({ frac, softFrac, mode }: { frac: number; softFrac: number; mode: 'normal' | 'soft' | 'hard' }) {
  const swung = useSwung();
  const fill = useRef<SVGPathElement>(null);
  useDynamicStyle(fill, { strokeDasharray: `${swung ? Math.min(100, frac * 100) : 0} 100` });
  let ticks = '';
  for (let i = 0; i <= 10; i++) {
    const a = ((135 + 27 * i) * Math.PI) / 180;
    const r2 = i % 5 === 0 ? 80 : 78;
    ticks += `M${(DIAL.cx + 75 * Math.cos(a)).toFixed(1)},${(DIAL.cy + 75 * Math.sin(a)).toFixed(1)} `
      + `L${(DIAL.cx + r2 * Math.cos(a)).toFixed(1)},${(DIAL.cy + r2 * Math.sin(a)).toFixed(1)} `;
  }
  const track = dialArc(0, 1, 60);
  return (
    <div className="relative w-[168px] flex-none">
      <svg viewBox="0 0 160 142" className="block h-auto w-full" aria-hidden="true">
        <path d={ticks} className="fill-none stroke-[var(--ink)] stroke-1" />
        <path d={track} className="fill-none stroke-[var(--separator-strong)] stroke-[12]" />
        <path
          ref={fill}
          d={track}
          pathLength={100}
          className={cn(
            'fill-none stroke-[12] transition-[stroke-dasharray] duration-[1600ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none',
            mode === 'hard' ? 'stroke-[var(--danger)]' : mode === 'soft' ? 'stroke-[var(--accent)]' : 'stroke-[var(--ink)]',
          )}
        />
        <path d={dialArc(Math.min(1, softFrac), 1, 70)} className="fill-none stroke-[var(--accent)] stroke-[3]" />
      </svg>
      <div className="absolute inset-x-0 top-0 bottom-2 grid place-content-center justify-items-center gap-0.5">
        <span className="font-mono text-[30px] leading-none font-bold tabular-nums">{Math.round(frac * 100)}%</span>
        <span className="font-mono text-[9px] tracking-[0.2em] text-muted uppercase">used today</span>
      </div>
    </div>
  );
}

function BudgetTile({ llm, statsDown }: { llm: LlmStats | null; statsDown: boolean }) {
  const budget = llm?.budget;
  const capped = !!budget?.enabled && budget.cap > 0;
  const cost = llm?.cost;
  return (
    <Cell className="gap-3.5 border-ink p-[18px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className={LABEL}>Token budget</span>
        <span className={NOTE}>resets 00:00 utc</span>
      </div>
      {!llm || !budget ? (
        statsDown ? <p className={cn(SUB, 'm-0')}>cannot reach the controller</p> : <Skeleton className="h-36 w-full" />
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          {capped ? (
            <BudgetDial frac={budget.usedToday / budget.cap} softFrac={budget.softPct / 100} mode={budget.mode} />
          ) : (
            <div className="grid gap-1">
              <span className="font-mono text-[30px] leading-none font-bold tabular-nums">{fmtTokens(budget.usedToday)}</span>
              <span className="font-mono text-[9px] tracking-[0.2em] text-muted uppercase">tokens today</span>
            </div>
          )}
          <div className="grid min-w-[130px] flex-1 gap-3.5">
            <div className="grid gap-[3px]">
              <span className={NOTE}>{capped ? 'used / cap' : 'daily cap'}</span>
              <span className="font-mono text-[16px] font-bold tabular-nums">
                {capped ? `${fmtTokens(budget.usedToday)} / ${fmtTokens(budget.cap)}` : 'none set'}
              </span>
              {capped && (
                <span className={SUB}>soft limit at {budget.softPct}% · mode {budget.mode}</span>
              )}
            </div>
            <div className="grid gap-1">
              <span className={NOTE}>est. cost · last {fmtInt(llm.count)} calls</span>
              <span className="font-mono text-[16px] font-bold tabular-nums">
                {cost ? `≈ ${fmtUsd(cost.usd)}` : '—'}
              </span>
              {cost && !cost.complete && <span className={SUB}>partial: a model with no list price</span>}
            </div>
          </div>
        </div>
      )}
    </Cell>
  );
}

export function FrontPanel({ listeners, llm, tts, requests, host, statsDown }: {
  listeners: {
    now: number | null;
    peak: number | null;
    avg: number | null;
    low: number | null;
    rangeLabel: string;
    loaded: boolean;
  };
  llm: LlmStats | null;
  tts: TtsStats | null;
  requests: RequestsStats | null;
  host: HostUsage | null;
  statsDown: boolean;
}) {
  const rows = llm && tts && requests ? healthRows(llm, tts, requests, host) : null;
  return (
    <Section title="At a glance" id="stats-glance" bare>
      <Panel className="overflow-hidden">
        <CellGrid min={260}>
          <ListenersTile {...listeners} />
          <HealthTile rows={rows} statsDown={statsDown} />
          <BudgetTile llm={llm} statsDown={statsDown} />
        </CellGrid>
      </Panel>
    </Section>
  );
}
