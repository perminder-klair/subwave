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

// Stable hash for the dedup set in segmentState. Same shape as
// hashHeadline() in news.ts.
export function hashCuriosity(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}
