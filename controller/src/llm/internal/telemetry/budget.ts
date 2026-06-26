// Daily LLM token counter — the running tally the budget cap is enforced
// against (see core/pure.ts `budgetMode`).
//
// Lives low in the dependency graph alongside log.ts so the call recorder can
// increment it without an upward import (no `settings`, no policy — just the
// number). The cap/thresholds and the normal/soft/hard policy live higher, in
// broadcast/dj-budget.ts, which reads `dailyTokensUsed()` from here.
//
// Bucketed by UTC day to match the events-*.jsonl files (which the seed below
// sums) and how most provider quota windows roll. The bucket resets itself when
// the UTC date changes, with no daemon — a long-running process crossing
// midnight simply reads 0 for the new day and accumulates from there.

import { readFile } from 'node:fs/promises';
import { STATE_DIR } from '../../../config.js';

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

let bucketDay = utcDay();
let bucketTokens = 0;

// Roll the bucket to today if the UTC date has advanced since the last touch.
function rollIfNeeded(): void {
  const today = utcDay();
  if (today !== bucketDay) {
    bucketDay = today;
    bucketTokens = 0;
  }
}

// Add a successful call's token total to today's tally. Called from log.ts
// record() under the same `ok && usage.total` guard as the lifetime counter.
export function addDailyUsage(tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  rollIfNeeded();
  bucketTokens += tokens;
}

// Tokens spent so far today (UTC). Reads 0 on a fresh day even with no add yet.
export function dailyTokensUsed(): number {
  rollIfNeeded();
  return bucketTokens;
}

// Seed today's tally from the durable event log on boot so a mid-day restart
// doesn't reset the count (the in-memory tally above is otherwise lost). Sums
// `usage.total` over today's successful `llm` events. Best-effort: a missing or
// unreadable file (fresh install, no calls yet) leaves the tally at 0. Run once
// at startup, before any new calls record — re-running would double-count.
export async function seedDailyUsageFromLog(): Promise<number> {
  const day = utcDay();
  let seeded = 0;
  try {
    const raw = await readFile(`${STATE_DIR}/logs/events-${day}.jsonl`, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type === 'llm' && e.ok && e.usage?.total) seeded += e.usage.total;
      } catch {
        // Skip a malformed line — never let one bad row abort the seed.
      }
    }
  } catch {
    // No file yet → nothing spent today.
  }
  bucketDay = day;
  bucketTokens = seeded;
  return seeded;
}
