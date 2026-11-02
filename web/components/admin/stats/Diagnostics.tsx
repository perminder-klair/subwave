'use client';

// Diagnostics: the detail an operator opens when something is off. Each row
// is a one-line summary with its breakdown folded underneath; the open state is
// the page's, so the On air transitions line can open its row.

import type { ReactNode } from 'react';
import { useId } from 'react';
import Link from 'next/link';
import { countRows, dropReasonLabel, effectLabel, effectSeamCount, reasonSummary } from '../../../lib/transitionStats';
import { Button } from '@/components/ui/button';
import { Bar, Cell, CellGrid, Hint, LABEL, Panel, SUB, Section } from './parts';
import { fmtInt, fmtPct, fmtSec, fmtTokens } from './format';
import type { LlmStats, RequestsStats, StatsResponse, TransitionStats } from './types';

export type DiagnosticKey = 'requests' | 'transitions';

function Row({ title, summary, open, onToggle, action, last, children }: {
  title: string;
  summary: ReactNode;
  open: boolean;
  onToggle?: () => void;
  // A link out, for a row whose detail lives on another page.
  action?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={last ? undefined : 'border-b border-ink'}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-[18px] py-3">
        <span className={`${LABEL} min-w-[130px]`}>{title}</span>
        <span className="font-mono text-[12px] text-muted">{summary}</span>
        {action && <span className="ml-auto">{action}</span>}
        {onToggle && (
          <Button variant="ghost" size="sm" className="ml-auto" aria-expanded={open} aria-controls={id} onClick={onToggle}>
            {open ? 'Close' : 'Open'}
          </Button>
        )}
      </div>
      {open && children && (
        <div id={id} className="border-t border-separator-strong">{children}</div>
      )}
    </div>
  );
}

function BarGroup({ title, rows, trailing }: {
  title: string;
  rows: { label: string; count: number }[];
  trailing?: (row: { label: string; count: number }) => ReactNode;
}) {
  const max = rows[0]?.count || 1;
  return (
    <Cell className="gap-2 px-[18px] py-3.5">
      <span className={LABEL}>{title}</span>
      {rows.length === 0 ? <Hint>none</Hint> : rows.map((r, i) => (
        <div key={r.label} className="grid grid-cols-[minmax(0,118px)_minmax(0,1fr)_minmax(44px,auto)] items-center gap-2.5 text-[12px]">
          <span className="truncate" title={r.label}>{r.label}</span>
          <Bar frac={r.count / max} lead={i === 0} />
          <span className="text-right font-mono font-bold tabular-nums">{trailing ? trailing(r) : fmtInt(r.count)}</span>
        </div>
      ))}
    </Cell>
  );
}

function requestsSummary(r: RequestsStats): string {
  const misses = r.artistMiss.count;
  return `${fmtInt(r.count)} requests · ${fmtInt(r.resolved)} found, ${fmtInt(r.failed)} not · avg ${fmtSec(r.latency.avg)}`
    + ` · ${fmtInt(misses)} artist ${misses === 1 ? 'miss' : 'misses'}${misses ? ` (${fmtPct(r.artistMiss.rate)})` : ''}`;
}

function RequestsDetail({ r }: { r: RequestsStats }) {
  const okByPath = new Map(r.byPath.map(p => [p.path, p]));
  // The path that resolves least often, when one falls short.
  const weakest = [...r.byPath].filter(p => p.ok < p.count).sort((a, b) => a.ok / a.count - b.ok / b.count)[0];
  return (
    <CellGrid min={280}>
      <Cell className="gap-[9px] px-[18px] py-3.5">
        <BarGroupBody
          title="By resolution path"
          rows={r.byPath.map(p => ({ label: p.path, count: p.count }))}
          trailing={row => {
            const p = okByPath.get(row.label);
            return p ? `${p.ok}/${p.count}` : fmtInt(row.count);
          }}
        />
        <span className={SUB}>
          p95 resolve {fmtSec(r.latency.p95)}
          {weakest && ` · ${weakest.path} resolves ${weakest.ok} of ${weakest.count}`}
        </span>
      </Cell>
      <BarGroup
        title="Where picks came from"
        rows={r.byPickSource.map(s => ({ label: s.source, count: s.count }))}
      />
      <Cell className="gap-1.5 px-[18px] py-3.5">
        <span className={LABEL}>Top requesters</span>
        {r.topRequesters.length === 0 ? <Hint>none</Hint> : r.topRequesters.map(q => (
          <div key={q.requester} className="flex justify-between gap-2.5 border-b border-separator-soft py-[3px] text-[12px]">
            <span className="truncate">{q.requester}</span>
            <span className="font-mono font-bold tabular-nums">{fmtInt(q.count)}</span>
          </div>
        ))}
      </Cell>
    </CellGrid>
  );
}

// BarGroup's rows without its own cell, for a cell that adds a footnote.
function BarGroupBody({ title, rows, trailing }: {
  title: string;
  rows: { label: string; count: number }[];
  trailing: (row: { label: string; count: number }) => ReactNode;
}) {
  const max = rows[0]?.count || 1;
  return (
    <>
      <span className={LABEL}>{title}</span>
      {rows.length === 0 ? <Hint>no paths recorded</Hint> : rows.map((row, i) => (
        <div key={row.label} className="grid grid-cols-[minmax(0,104px)_minmax(0,1fr)_60px] items-center gap-2.5 text-[12px]">
          <span className="truncate" title={row.label}>{row.label}</span>
          <Bar frac={row.count / max} lead={i === 0} />
          <span className="text-right font-mono font-bold tabular-nums">{trailing(row)}</span>
        </div>
      ))}
    </>
  );
}

function activeWindow(llm: LlmStats, trackSelection: StatsResponse['trackSelection']) {
  const ctx = llm.contextWindows;
  return trackSelection === 'shortlist'
    ? { label: 'shortlist', window: ctx?.shortlist }
    : { label: 'agentic', window: ctx?.agenticPicker };
}

function contextSummary(llm: LlmStats, trackSelection: StatsResponse['trackSelection']): ReactNode {
  const { label, window } = activeWindow(llm, trackSelection);
  if (!window?.suggestedTokens) return window?.message || 'waiting for context-window evidence';
  return (
    <>
      {label} recommends <b className="text-vermilion">{fmtTokens(window.suggestedTokens)}</b> num_ctx
      {' · '}{fmtTokens(window.peakInputTokens)} peak prompt
      {window.headroomPct != null && ` · ${window.headroomPct}% headroom`}
    </>
  );
}

function transitionsSummary(t: TransitionStats | null): string {
  if (!t) return 'play history unavailable';
  if (t.seams === 0) return 'no transitions recorded yet: each aired track records how it came in';
  const withEffect = effectSeamCount(t.bySeam);
  const effectAsks = t.asked - (t.byAsk.normal ?? 0);
  return `${fmtInt(t.seams)} seams · ${fmtInt(withEffect)} with an effect (${fmtPct(withEffect / t.seams)})`
    + ` · ${fmtInt(t.asked)} DJ asks, ${fmtInt(effectAsks)} for an effect · ${fmtInt(t.dropped)} dropped`;
}

// Each effect that lost its seam, with why, so a recurring cause stands out.
function DropsByEffect({ t }: { t: TransitionStats }) {
  const rows = Object.entries(t.byEffect ?? {})
    .map(([effect, rec]) => ({
      effect: effectLabel(effect),
      count: Object.values(rec ?? {}).reduce<number>((sum, n) => sum + (n || 0), 0),
      reasons: reasonSummary(rec),
    }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count || a.effect.localeCompare(b.effect));
  const max = rows[0]?.count || 1;
  return (
    <Cell className="gap-2 px-[18px] py-3.5">
      <span className={LABEL}>Drops by effect</span>
      {rows.length === 0 ? <Hint>nothing dropped</Hint> : rows.map((r, i) => (
        <div key={r.effect} className="grid gap-1">
          <div className="grid grid-cols-[minmax(0,118px)_minmax(0,1fr)_minmax(44px,auto)] items-center gap-2.5 text-[12px]">
            <span className="truncate" title={r.effect}>{r.effect}</span>
            <Bar frac={r.count / max} lead={i === 0} />
            <span className="text-right font-mono font-bold tabular-nums">{fmtInt(r.count)}</span>
          </div>
          <span className={SUB}>{r.reasons}</span>
        </div>
      ))}
    </Cell>
  );
}

function TransitionsDetail({ t }: { t: TransitionStats }) {
  return (
    <CellGrid min={260}>
      <BarGroup title="The DJ asked for" rows={countRows(t.byAsk, effectLabel)} />
      <BarGroup title="Seams armed" rows={countRows(t.bySeam)} />
      <BarGroup title="Why effects dropped" rows={countRows(t.byReason, dropReasonLabel)} />
      <DropsByEffect t={t} />
    </CellGrid>
  );
}

export function Diagnostics({ requests, llm, trackSelection, transitions, open, onToggle }: {
  requests: RequestsStats | null;
  llm: LlmStats | null;
  trackSelection: StatsResponse['trackSelection'];
  transitions: TransitionStats | null | undefined;
  open: Record<DiagnosticKey, boolean>;
  onToggle: (key: DiagnosticKey) => void;
}) {
  if (!requests || !llm) {
    return (
      <Section title="Diagnostics" sub="open when something's off" id="stats-diagnostics">
        <Panel className="p-[18px]"><Hint>connecting…</Hint></Panel>
      </Section>
    );
  }
  const hasTransitions = transitions !== undefined;
  return (
    <Section title="Diagnostics" sub="open when something's off" id="stats-diagnostics">
      <Panel>
        <Row
          title="Requests"
          summary={requests.count ? requestsSummary(requests) : 'no listener requests yet'}
          open={open.requests}
          onToggle={requests.count ? () => onToggle('requests') : undefined}
        >
          <RequestsDetail r={requests} />
        </Row>
        {/* num_ctx is an Ollama setting, so the sizing only matters there; its
            detail sits beside the field in Settings → LLM, where it is acted on. */}
        {llm.provider === 'ollama' && (
          <Row
            title="Context windows"
            summary={contextSummary(llm, trackSelection)}
            open={false}
            action={(
              <Link
                href="/admin/settings?section=llm"
                className="font-mono text-[11px] text-ink underline underline-offset-[3px] hover:text-vermilion"
              >
                num_ctx in Settings → LLM
              </Link>
            )}
            last={!hasTransitions}
          />
        )}
        {hasTransitions && (
          <Row
            title={`Transitions · ${transitions?.days ?? 7}d`}
            summary={transitionsSummary(transitions)}
            open={open.transitions}
            onToggle={transitions && transitions.seams > 0 ? () => onToggle('transitions') : undefined}
            last
          >
            {transitions && <TransitionsDetail t={transitions} />}
          </Row>
        )}
      </Panel>
    </Section>
  );
}
