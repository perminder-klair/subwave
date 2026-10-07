// Count tokens by UTC day, matching events-*.jsonl; reset on the next read after midnight.
// This module stores the count; broadcast/dj-budget.ts owns cap policy.

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

// Add a call's token total to today's tally. Called from log.ts record() for
// every call that reports usage, failed ones included (issue #1195) — unlike
// the lifetime counter beside it, which stays success-only. The provider bills
// for a call that throws, so a cap that ignored them capped successful spend.
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
// `usage.total` over today's `llm` events. Best-effort: a missing or unreadable
// file (fresh install, no calls yet) leaves the tally at 0. Run once at
// startup, before any new calls record — re-running would double-count.
//
// This filter must stay in lockstep with addDailyUsage's caller in log.ts: it
// is a SECOND, independent copy of the same policy, and the two disagreeing is
// silent. Screening `ok` here while log.ts counts failures would make a mid-day
// restart re-seed from successes only and walk the tally BACKWARDS — an
// operator pushed into `hard` by failure spend would drop back to `normal` on a
// container bounce. `logEvent('llm', …)` writes `usage` outside its own ok
// guard, so failure spend is already on the timeline to be summed.
export async function seedDailyUsageFromLog(): Promise<number> {
  const day = utcDay();
  let seeded = 0;
  try {
    const raw = await readFile(`${STATE_DIR}/logs/events-${day}.jsonl`, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type === 'llm' && e.usage?.total) seeded += e.usage.total;
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
