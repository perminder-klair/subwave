// Daily LLM token budget — the enforcement policy.
//
// Combines the running token tally (llm/log.js `dailyTokensUsed`) with the
// configured cap/threshold (settings.llm) into a single mode, then exposes the
// yes/no questions the call sites actually ask. The mode itself is the pure
// `budgetMode` (llm/internal/core/pure.ts, unit-pinned); this file is the thin
// glue that reads the live numbers.
//
// Three tiers (see budgetMode):
//   normal — everything runs.
//   soft   — at budgetSoftPct of the cap: drop to the cheap pool picker, mute
//            optional segments (links, station IDs, hourly, weather/news/etc.).
//            Picks still happen (the stream needs a next track) but cheaply.
//   hard   — at the cap: no model calls at all. The picker stops feeding the
//            queue, so Liquidsoap falls through to the LLM-free auto playlist —
//            music never stops. Listener requests are still honoured unless
//            llm.exemptRequests is off.
//
// cap = 0 (the default) → always normal: zero behaviour change for the free
// local-Ollama install that most operators run.

import * as settings from '../settings.js';
import { dailyTokensUsed, budgetMode } from '../llm/log.js';

export type BudgetMode = 'normal' | 'soft' | 'hard';

// Current mode from live usage + settings. Reads 'normal' whenever the cap is
// disabled, so every gate below is a no-op on a default install.
export function currentMode(): BudgetMode {
  const llm = settings.get()?.llm || ({} as any);
  return budgetMode({
    used: dailyTokensUsed(),
    cap: llm.dailyTokenCap ?? 0,
    softPct: llm.budgetSoftPct ?? 80,
  });
}

// May we spend a model call on picking the next track? False only at the hard
// cap — then the queue isn't fed and the auto playlist takes over.
export function picksAllowed(): boolean {
  return currentMode() !== 'hard';
}

// In soft/hard mode, prefer the cheap stateless pool picker (one djObject call)
// over the multi-step agent tool-loop.
export function preferCheapPicker(): boolean {
  return currentMode() !== 'normal';
}

// May we spend a model call on an OPTIONAL segment (links, station IDs, hourly
// time checks, weather/news/curiosity/etc.)? Only in normal mode — these are
// the first thing dropped to stretch the budget.
export function optionalSegmentsAllowed(): boolean {
  return currentMode() === 'normal';
}

// May the listener-request agent run? Honoured through the hard cap when
// llm.exemptRequests is on (a human asked); otherwise gated like everything
// else and the caller falls back to its stateless matcher cascade.
export function requestsAllowed(): boolean {
  if (currentMode() !== 'hard') return true;
  return !!settings.get()?.llm?.exemptRequests;
}

// Snapshot for the admin /debug surface: where today's usage sits against the
// cap and which tier that puts the DJ in.
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
