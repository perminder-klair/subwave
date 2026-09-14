// Feeds — the one place a skill's `feed:` frontmatter turns into data on air.
//
// Two layers live here:
//
//   1. FETCH + PARSE. `parseFeed` is the pure seam (no network, no config),
//      pinned by scripts/feed-parse.test.ts. Parsing goes through
//      fast-xml-parser rather than the regex scanner this module shipped with.
//      The feed URL is OPERATOR input — any URL typed into a skill's `feed:`
//      field — and the old scanner only matched shallow RSS 2.0 `<item>`
//      blocks: an Atom feed (`<entry>`/`<summary>`), an RDF/RSS-1.0 feed
//      (`<item>` at the document root, no `<channel>`), a namespaced title
//      (`<dc:title>`), or a nested CDATA section all returned ZERO items. That
//      failure is silent — the segment director just finds no headlines and the
//      beat quietly never airs — which is why it's worth a dependency.
//
//   2. THE GENERIC FEED TOOL (#1616). `feed:` / `feedMaxItems:` used to be
//      config for ONE hand-written tool.mjs — the built-in news skill's — so a
//      custom skill could declare both, have them validate, save and read back
//      everywhere, and still reach the model with no feed content and no
//      `skill_<name>` tool at all. The declaration is the mechanism now:
//      `resolveFeedConfig` reads a skill's own frontmatter and `makeFeedTool`
//      builds the fetch/dedupe/truncate tool the loader attaches to any skill
//      that has no tool.mjs of its own. News goes through that path like
//      everything else — it no longer ships a tool.mjs.
//
// This file was `skills/news.ts` until #1616. Nothing in it was ever
// news-specific; the name was the reason the mechanism read as news-only.

import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';

// The frontmatter keys that declare a feed. One spelling, shared by the
// resolver, the admin knobs and the docs.
export const FEED_URL_KEY = 'feed';
export const FEED_MAX_ITEMS_KEY = 'feedMaxItems';

// Upper bound on `feedMaxItems`, and the `max` the admin number field enforces.
export const FEED_MAX_ITEMS_LIMIT = 50;

export interface Headline {
  title: string;
  description: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  ignoreDeclaration: true,
  // Namespace prefixes are noise here and actively harmful: an RDF feed's root
  // is `rdf:RDF`, and plenty of feeds carry `dc:title` / `content:encoded`.
  // Stripping them collapses every dialect onto the same plain tag names.
  removeNSPrefix: true,
  // Keep every value a STRING. With the default numeric coercion a headline of
  // "2026" arrives as the number 2026 and a version-like title ("1.2.3") can
  // lose a component — text is text.
  parseTagValue: false,
  parseAttributeValue: false,
});

// A parsed node is a string, or an object carrying its text under `#text` when
// the element had attributes (`<title type="html">…</title>`), or an array when
// the tag repeated. Flatten all three to a plain string.
function textOf(node: unknown): string {
  if (node == null) return '';
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') return textOf((node as Record<string, unknown>)['#text']);
  return String(node);
}

function stripHtml(s: string): string {
  return (s || '')
    // Entities are decoded by the parser; these handle a doubly-encoded feed,
    // where the decoded text still contains &amp;-style escapes.
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asRecord(node: unknown): Record<string, unknown> | null {
  return node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>) : null;
}

// Locate the entry list across the three dialects in the wild:
//   RSS 2.0    <rss><channel><item>…
//   RSS 1.0    <RDF><item>…            (items are siblings of <channel>, not children)
//   Atom       <feed><entry>…
// Returns [] when the document is not a feed at all.
function entriesOf(doc: Record<string, unknown>): Record<string, unknown>[] {
  const roots: Record<string, unknown>[] = [];
  for (const value of Object.values(doc)) {
    const root = asRecord(value);
    if (!root) continue;
    roots.push(root);
    // RSS 2.0 nests the items one level deeper, under <channel>.
    const channel = asRecord(root.channel);
    if (channel) roots.push(channel);
  }
  for (const root of roots) {
    const found = root.item ?? root.entry;
    if (found == null) continue;
    const list = Array.isArray(found) ? found : [found];
    return list.map(asRecord).filter((e): e is Record<string, unknown> => e !== null);
  }
  return [];
}

// Parse a feed document into at most `cap` headlines. Entries with no title are
// dropped — a headline the DJ cannot read is not a headline.
export function parseFeed(xml: string, cap: number): Headline[] {
  let doc: Record<string, unknown> | null = null;
  try {
    doc = asRecord(parser.parse(xml));
  } catch {
    // Malformed XML — treat it as an empty feed rather than throwing into the
    // segment director, which is what the regex scanner did by construction.
    return [];
  }
  if (!doc) return [];

  const out: Headline[] = [];
  for (const entry of entriesOf(doc)) {
    if (out.length >= cap) break;
    const title = stripHtml(textOf(entry.title));
    if (!title) continue;
    // RSS carries the blurb in <description>; Atom uses <summary>, falling back
    // to <content> (which, post-removeNSPrefix, is also where RSS's
    // <content:encoded> lands).
    const description = stripHtml(textOf(entry.description ?? entry.summary ?? entry.content));
    out.push({ title, description });
  }
  return out;
}

export function hashHeadline(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  return h.toString(36);
}

export async function fetchHeadlines({ feedUrl, maxItems }: { feedUrl?: string; maxItems?: number } = {}) {
  const url = feedUrl || config.news.feedUrl;
  const cap = maxItems || config.news.maxItems;
  // Bounded like the web-search backends. The feed URL is operator-set
  // (skills/news/SKILL.md `feed:`), so this is not an injection sink — the
  // deadline is about liveness. It runs inside the segment director on the
  // autonomous DJ path, where a hung socket would otherwise park the whole
  // segment on undici's ~300s default and eat the agent's own 45s budget many
  // times over. 15s is generous for an RSS document.
  const res = await fetchWithTimeout(url, { timeoutMs: 15_000 });
  if (!res.ok) throw new Error(`News feed HTTP ${res.status}`);
  return parseFeed(await res.text(), cap);
}

// ---------------------------------------------------------------------------
// The generic feed tool (#1616)
//
// A skill declares `feed:` in its own SKILL.md frontmatter and gets a
// `skill_<name>` fetch tool over that feed — the same dedupe and truncation the
// built-in news skill used to hand-roll in its own tool.mjs. The policy lives
// here rather than at the loader call site because three things ask about it:
// the loader (does this skill get a tool?), the admin form (which knobs does it
// render?) and the tool itself (what does a fire return?).
// ---------------------------------------------------------------------------

// The operator knobs a feed-capable skill exposes in /admin/skills. Handed to
// `parseConfigFields` by the loader, exactly like a tool.mjs `configFields`
// export — one sanitiser, not a second copy. Kept as the raw declaration so the
// shape a skill author writes and the shape the built-in path uses are the same.
export const FEED_CONFIG_FIELDS = {
  feed: {
    type: 'url',
    label: 'Feed URL · RSS or Atom',
    placeholder: 'https://…/rss.xml',
    hint: 'Set this and the skill fetches the feed before it speaks.',
  },
  feedMaxItems: {
    type: 'number',
    label: 'Max items',
    min: 1,
    max: FEED_MAX_ITEMS_LIMIT,
    integer: true,
    placeholder: '10',
  },
} as const;

// How many FRESH items one fire hands the model. This is the news skill's
// historical return cap, kept for every feed skill: `feedMaxItems` caps how much
// of the feed is read (and so lowers this ceiling when it is smaller), while
// this caps how much of it is spent — burning a whole 50-item feed on one
// between-track aside leaves nothing for the next break.
export const FEED_ITEMS_PER_FIRE = 6;

// Burn-on-read memory, per skill. Trimmed rather than grown without bound; a
// feed that rotates faster than the trim just re-offers an old item eventually,
// which is the harmless direction.
const SEEN_HIGH_WATER = 120;
const SEEN_KEEP = 60;

export interface ResolvedFeed {
  url: string;
  maxItems: number;
}

export interface FeedResolution {
  /** null when this skill declares no usable feed — it stays prompt-only. */
  feed: ResolvedFeed | null;
  /**
   * Operator-facing problems with what was declared. The loader logs each one:
   * a `feed:` line that cannot be fetched must say so, because the failure it
   * replaces (issue #1616) was a field that validated, saved, read back and
   * then silently did nothing.
   */
  warnings: string[];
}

// Read a skill's own frontmatter into a feed declaration.
//
// Absent or cleared is not an error — a skill without a feed is the ordinary
// prompt-only skill. A PRESENT but unusable value is: it is the operator saying
// "fetch this" in the one place that means it.
export function resolveFeedConfig(config: Record<string, unknown> | null | undefined): FeedResolution {
  const warnings: string[] = [];
  const raw = config?.[FEED_URL_KEY];
  const url = raw == null ? '' : String(raw).replace(/[\r\n\t]/g, '').trim();
  if (!url) return { feed: null, warnings };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    warnings.push(`feed: "${url}" is not a URL — no feed tool was generated`);
    return { feed: null, warnings };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    warnings.push(`feed: "${url}" is not an http(s) URL — no feed tool was generated`);
    return { feed: null, warnings };
  }

  return { feed: { url, maxItems: resolveMaxItems(config?.[FEED_MAX_ITEMS_KEY], warnings) }, warnings };
}

// `feedMaxItems` is lenient where the URL is strict: a broken count still has an
// obvious right answer (the station default), while a broken URL has none.
function resolveMaxItems(raw: unknown, warnings: string[]): number {
  const fallback = config.news.maxItems;
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > FEED_MAX_ITEMS_LIMIT) {
    warnings.push(`feedMaxItems: "${raw}" is not a whole number between 1 and ${FEED_MAX_ITEMS_LIMIT} — using ${fallback}`);
    return fallback;
  }
  return n;
}

// The per-skill burn-on-read set, kept on the segment director's cross-tick
// state. Namespaced by kind: two skills reading two feeds must not suppress each
// other's items just because a headline hashes the same.
function seenSetFor(state: any, kind: string): Set<string> {
  if (!state || typeof state !== 'object') return new Set<string>();
  if (!(state.feedSeen instanceof Map)) state.feedSeen = new Map<string, Set<string>>();
  let seen = state.feedSeen.get(kind);
  if (!(seen instanceof Set)) {
    seen = new Set<string>();
    state.feedSeen.set(kind, seen);
  }
  return seen;
}

// Build the data tool for a declared feed. Same signature as a skill's own
// tool.mjs default export, so the loader attaches it to `cap.toolFn` and every
// caller (llm/internal/tools/segment-tools.ts, the forced path, the co-hosted
// path) is unchanged — including the timeout and the `{ error }` degradation.
//
// Returns the news shape, `{ headlines: [{ title, detail }] }`, unchanged from
// the tool.mjs this replaces: an empty array is "nothing fresh", not an error.
export function makeFeedTool(kind: string, feed: ResolvedFeed) {
  return async function fetchFeedItems(_ctx?: unknown, state?: any) {
    const seen = seenSetFor(state, kind);
    const items = await fetchHeadlines({ feedUrl: feed.url, maxItems: feed.maxItems });
    const fresh = items.filter(it => !seen.has(hashHeadline(it.title))).slice(0, FEED_ITEMS_PER_FIRE);
    // Burn on read so a later tick doesn't re-offer the same item.
    for (const it of fresh) seen.add(hashHeadline(it.title));
    if (seen.size > SEEN_HIGH_WATER) {
      const kept = Array.from(seen).slice(-SEEN_KEEP);
      seen.clear();
      for (const h of kept) seen.add(h);
    }
    return { headlines: fresh.map(it => ({ title: it.title, detail: it.description || null })) };
  };
}
