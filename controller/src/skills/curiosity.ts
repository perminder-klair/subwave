// Curiosity fetcher — the data layer behind the `curiosity` capability. The
// segment-director agent (skills/_agent.ts) calls the `getCuriosityItem` tool
// (llm/segment-tools.ts) for a single oddly-specific factoid to read on air.
//
// Internally rotates across three sources, picked deterministically per call:
//   1. Wikipedia on-this-day events for today's date (filtered for non-violent
//      cultural/scientific/sport entries since 1850 to keep the tone right);
//   2. Opportunistic ISS overhead pass — only when the station knows an event
//      is imminent in the operator's location (not implemented yet — returns
//      `available: false` until a structured source is wired in);
//   3. LLM-only "did you know" line — same prompt path the legacy random-facts
//      capability used; the agent generates from `cap.desc` + persona on its
//      own when the data sources return nothing.
//
// Source (3) is the implicit fallback: the tool returns `{ available: false }`
// when no external item is available, which prompts the agent to fall through
// to pure generation under `cap.desc`. So this file is "what extra context can
// we put under the DJ's nose this minute?" — never "must we be silent?".

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { zonedParts, zonedISODate } from '../time.js';

const ON_THIS_DAY_TTL_MS = 12 * 60 * 60 * 1000; // 12h — events for a date are stable

// Wikipedia REST asks API consumers to identify themselves. Anonymous calls
// are rate-limited harder; this string keeps us in the friendlier bucket and
// is informative if their abuse desk ever wants to reach a human.
const USER_AGENT = 'subwave-radio/0.1 (+https://github.com/perminder-klair/subwave)';

type CuriosityItem = {
  source: 'on-this-day';
  year: number;
  text: string;
  category?: string;
};

let onThisDayCache: { date: string; items: CuriosityItem[]; fetchedAt: number } | null = null;

// Categories Wikipedia tags on-this-day events with that we keep. Wikipedia's
// own categories include "wars", "deaths", and "politics" which we explicitly
// drop — the tone there is wrong for a music station.
const ALLOWED_CATEGORY_HINTS = [
  'music', 'science', 'sport', 'culture', 'art', 'film', 'literature',
  'invention', 'discovery', 'space', 'aviation', 'technology', 'mathematics',
];
const BANNED_TOKENS = [
  // Drop war/violence/death-heavy entries — even older events read wrong on
  // a music station between tracks.
  'war', 'battle', 'massacre', 'genocide', 'assassinat', 'execut', 'killed',
  'invasion', 'siege', 'bomb', 'shoot', 'murder', 'slain', 'casualt',
  'died', 'dies ', 'death of', 'crash', 'disaster', 'tragedy',
];

function looksAllowed(text: string, category?: string) {
  const t = text.toLowerCase();
  for (const ban of BANNED_TOKENS) if (t.includes(ban)) return false;
  if (category) {
    const c = category.toLowerCase();
    if (ALLOWED_CATEGORY_HINTS.some(h => c.includes(h))) return true;
  }
  // No category — keep if it looks cultural/scientific by surface form
  // (mentions of "released", "founded", "debut", "first" tend to be safe).
  return /\b(released|published|founded|debut|first|opened|broadcast|premiered|launched|recorded)\b/.test(t);
}

function mmdd(d: Date) {
  // Station-zone date — "on this day" should match the day the DJ announces.
  const { month, day } = zonedParts(d);
  return {
    mm: String(month).padStart(2, '0'),
    dd: String(day).padStart(2, '0'),
    iso: zonedISODate(d),
  };
}

export async function fetchOnThisDay(date = new Date()): Promise<CuriosityItem[]> {
  const { mm, dd, iso } = mmdd(date);
  if (onThisDayCache && onThisDayCache.date === iso
      && Date.now() - onThisDayCache.fetchedAt < ON_THIS_DAY_TTL_MS) {
    return onThisDayCache.items;
  }
  const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${mm}/${dd}`;
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Wikipedia on-this-day HTTP ${res.status}`);
  const data = await res.json() as any;
  const events = Array.isArray(data?.events) ? data.events : [];

  const items: CuriosityItem[] = [];
  for (const ev of events) {
    const year = Number(ev?.year);
    const text = String(ev?.text || '').trim();
    if (!text || !Number.isFinite(year) || year < 1850) continue;
    // Wikipedia's per-event category is in `pages[].normalizedtitle` indirectly;
    // we don't have a clean category field, so we filter on the text content.
    if (!looksAllowed(text)) continue;
    items.push({ source: 'on-this-day', year, text });
    if (items.length >= 8) break;
  }
  onThisDayCache = { date: iso, items, fetchedAt: Date.now() };
  return items;
}

// Stable hash for the dedup ledger. Same shape as hashHeadline() in news.ts.
export function hashCuriosity(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

// ---------------------------------------------------------------------------
// Durable curiosity dedup ledger (issue #577)
//
// Two failure modes the ledger closes:
//   1. The dedup set used to be an in-memory `Set` (skills/_agent.ts), wiped on
//      every controller restart. Wikipedia returns the same "on this day" items
//      for a date all day, so a restart re-aired the same fact hours later.
//   2. When the small Wikipedia pool exhausts, the agent free-generates a
//      factoid under the capability brief with no record of what it already
//      said — so it regenerated the same one (reworded).
//
// The ledger persists BOTH the items surfaced to the agent (so the tool stops
// re-offering the same Wikipedia event across a restart — the surfaced item's
// hash matches on the next fetch, the reworded aired line would not) AND the
// lines actually aired (so fallback generation can be told what to avoid).
// Surviving a restart, pruned to `config.curiosity.maxAgeDays`.
// ---------------------------------------------------------------------------

type CuriosityLedgerEntry = { hash: string; text: string; at: string; aired: boolean };

let ledger: CuriosityLedgerEntry[] = [];
let seenHashes = new Set<string>();
let persistTimer: NodeJS.Timeout | null = null;

// Pure: drop entries older than `maxAgeMs` and keep at most `maxEntries`
// (newest first). Side-effect-free so it can be reasoned about / unit-pinned.
export function pruneCuriosityLedger(
  entries: CuriosityLedgerEntry[],
  now: number,
  maxAgeMs: number,
  maxEntries: number,
): CuriosityLedgerEntry[] {
  const cutoff = now - maxAgeMs;
  return entries
    .filter(e => e && e.hash && e.at && new Date(e.at).getTime() > cutoff)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, maxEntries);
}

function rebuildHashes() {
  seenHashes = new Set(ledger.map(e => e.hash));
}

// Boot recovery — read the ledger, prune stale entries, prime the dedup set.
// Never throws: a missing or corrupt file just starts an empty ledger.
export function loadCuriosityLedger() {
  ledger = [];
  try {
    if (existsSync(config.curiosity.seenFile)) {
      const raw = JSON.parse(readFileSync(config.curiosity.seenFile, 'utf8'));
      if (Array.isArray(raw)) {
        ledger = pruneCuriosityLedger(
          raw,
          Date.now(),
          config.curiosity.maxAgeDays * 86_400_000,
          config.curiosity.maxEntries,
        );
      }
    }
  } catch (err: any) {
    console.error('[curiosity] ledger load failed:', err.message);
    ledger = [];
  }
  rebuildHashes();
  return ledger.length;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await writeFile(config.curiosity.seenFile, JSON.stringify(ledger, null, 2));
    } catch (err: any) {
      console.error('[curiosity] ledger persist failed:', err.message);
    }
  }, 500);
}

// Has this exact curiosity text already been surfaced or aired? Used by the
// segment tool to filter the Wikipedia pool.
export function curiositySeen(text: string) {
  return seenHashes.has(hashCuriosity(text));
}

// Record a curiosity text in the ledger. `aired` marks lines the listener
// actually heard (fed back into fallback generation); surfaced-but-not-aired
// Wikipedia items are recorded with aired=false purely for tool dedup. A repeat
// hash refreshes the timestamp (and promotes to aired) rather than duplicating.
export function recordCuriosity(text: string, { aired = false }: { aired?: boolean } = {}) {
  const clean = (text || '').trim();
  if (!clean) return;
  const hash = hashCuriosity(clean);
  const at = new Date().toISOString();
  const existing = ledger.find(e => e.hash === hash);
  if (existing) {
    existing.at = at;
    if (aired) existing.aired = true;
  } else {
    ledger.unshift({ hash, text: clean, at, aired });
    seenHashes.add(hash);
  }
  if (ledger.length > config.curiosity.maxEntries) {
    ledger = ledger.slice(0, config.curiosity.maxEntries);
    rebuildHashes();
  }
  schedulePersist();
}

// The most recent curiosity lines actually aired (newest first), for the
// fallback brief — so the agent's free generation avoids repeating them.
export function recentAiredCuriosity(limit = 8): string[] {
  return ledger
    .filter(e => e.aired)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map(e => e.text);
}
