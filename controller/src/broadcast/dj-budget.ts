// Daily LLM token budget. Live token tally + settings.llm cap resolved by the
// pure `budgetMode`; this file is the glue and the yes/no questions.
//
//   normal — everything runs.
//   soft   — at budgetSoftPct: cheap pool picker, no optional segments.
//   hard   — at the cap: no model calls; Liquidsoap coasts on auto.m3u.
//
// cap = 0 (the default) is always normal.

import * as settings from '../settings.js';
import { dailyTokensUsed, budgetMode } from '../llm/log.js';

export type BudgetMode = 'normal' | 'soft' | 'hard';

// 'normal' whenever the cap is disabled, so every gate below is a no-op.
export function currentMode(): BudgetMode {
  const llm = settings.get()?.llm || ({} as any);
  return budgetMode({
    used: dailyTokensUsed(),
    cap: llm.dailyTokenCap ?? 0,
    softPct: llm.budgetSoftPct ?? 80,
  });
}

// False only at the hard cap, where the auto playlist takes over.
export function picksAllowed(): boolean {
  return currentMode() !== 'hard';
}

// Soft/hard: prefer the cheap stateless pool picker over the agent tool-loop.
export function preferCheapPicker(): boolean {
  return currentMode() !== 'normal';
}

// Optional segments (links, idents, hourly, features) run in normal mode only.
export function optionalSegmentsAllowed(): boolean {
  return currentMode() === 'normal';
}

// Honoured through the hard cap when llm.exemptRequests is on; otherwise the
// caller falls back to its stateless matcher cascade.
export function requestsAllowed(): boolean {
  if (currentMode() !== 'hard') return true;
  return !!settings.get()?.llm?.exemptRequests;
}

export function budgetStatus() {
  const llm = settings.get()?.llm || ({} as any);
  const cap = llm.dailyTokenCap ?? 0;
  const used = dailyTokensUsed();
  return {
    enabled: cap > 0,
    cap,
    softPct: llm.budgetSoftPct ?? 80,
    exemptRequests: !!llm.exemptRequests,
    usedToday: used,
    remaining: cap > 0 ? Math.max(0, cap - used) : null,
    mode: currentMode(),
  };
}
