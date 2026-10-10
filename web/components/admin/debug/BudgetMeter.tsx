'use client';

import type { ReactNode } from 'react';
import { Pill } from '../ui';
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
} from '../../ai-elements/context';
import type { DebugBudget } from './types';

export function BudgetMeter({ budget }: { budget: DebugBudget }) {
  const cap = budget.cap ?? 0;
  const used = budget.usedToday ?? 0;
  if (!budget.enabled || cap <= 0) return null;
  const mode = budget.mode || 'normal';
  const compact = (n: number) =>
    new Intl.NumberFormat('en-US', { notation: 'compact' }).format(n);
  const pct = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(used / cap);
  return (
    <span className="flex items-center gap-1.5">
      <span className="caption">tokens</span>
      <Context maxTokens={cap} usedTokens={used}>
        <ContextTrigger className="h-auto gap-1 rounded-none px-1.5 py-0.5 text-[11px]" />
        <ContextContent align="start" className="rounded-none border-ink bg-bg">
          <ContextContentHeader>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span>{pct} of daily cap</span>
              <span className="mono-num text-muted">
                {compact(used)} / {compact(cap)}
              </span>
            </div>
          </ContextContentHeader>
          <ContextContentBody className="grid gap-1.5">
            <BudgetRow label="used today" value={used.toLocaleString('en-US')} />
            <BudgetRow
              label="remaining"
              value={(budget.remaining ?? Math.max(0, cap - used)).toLocaleString('en-US')}
            />
            <BudgetRow
              label="soft threshold"
              value={budget.softPct != null ? `${budget.softPct}%` : '—'}
            />
            <BudgetRow label="requests exempt" value={budget.exemptRequests ? 'yes' : 'no'} />
          </ContextContentBody>
        </ContextContent>
      </Context>
      <Pill
        tone={mode === 'soft' ? 'accent' : undefined}
        className={mode === 'hard' ? 'border-[var(--danger)] text-[var(--danger)]' : undefined}
        title={
          mode === 'hard'
            ? 'cap reached — no model calls until the UTC day rolls'
            : mode === 'soft'
              ? 'soft threshold reached — cheap picker, optional segments muted'
              : 'under budget'
        }
      >
        budget {mode}
      </Pill>
    </span>
  );
}

function BudgetRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="caption">{label}</span>
      <span className="mono-num">{value}</span>
    </div>
  );
}


