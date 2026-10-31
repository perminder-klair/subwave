// Parse RSS/Atom/RDF feeds with fast-xml-parser; see scripts/feed-parse.test.ts.
// A skill with feed frontmatter and no tool.mjs receives makeFeedTool from the loader (#1616).
// News uses the same generic path; config comes from resolveFeedConfig.

import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { zonedISODate } from '../time.js';

// The frontmatter keys that declare a feed. One spelling, shared by the
// resolver, the admin knobs and the docs.
export const FEED_URL_KEY = 'feed';
export const FEED_MAX_ITEMS_KEY = 'feedMaxItems';
export const FEED_MAX_AGE_KEY = 'feedMaxAgeDays';
// Optional further feeds read alongside `feed`, merged into one list.
export const FEED_EXTRA_URL_KEYS = ['feed2', 'feed3'] as const;

// Upper bound on `feedMaxItems`, and the `max` the admin number field enforces.
export const FEED_MAX_ITEMS_LIMIT = 50;
// Upper bound on `feedMaxAgeDays`.
export const FEED_MAX_AGE_LIMIT = 365;

export interface Headline {
  title: string;
  description: string;
  /** ISO time the item was published, present only when the feed dates it. */
  published?: string;
}

export interface ParseOptions {
  /** Drop items published longer ago than this. Undated items are kept. */
  maxAgeDays?: number | null;
  now?: number;
}

// An item's publish time across the dialects: RSS 2.0 <pubDate>, Atom
// <published>/<updated>, RSS 1.0 <dc:date> (prefix stripped to <date>).
// Unparseable or absent is null, never "now": an item we cannot date is not
// thereby fresh, but nor is it provably stale. That includes zone names
// Date.parse does not know ("CEST"): such an item is kept as undated, the safe
// direction, on purpose.
function publishedOf(entry: Record<string, unknown>): number | null {
  for (const node of [entry.pubDate, entry.published, entry.updated, entry.date, entry.issued]) {
    const text = textOf(node).trim();
    if (!text) continue;
    const t = Date.parse(text);
    if (Number.isFinite(t)) return t;
  }
  return null;
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

// A reference outside Unicode's range is left as the text it was rather than
// throwing out of the parse.
function fromCodePoint(code: number, ref: string): string {
  try { return String.fromCodePoint(code); } catch { return ref; }
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
    // Numeric character references. The parser decodes only the five named XML
    // entities, so WordPress punctuation (&#8217;, &#038;) reached the model as
    // literal text. Runs after &amp; so a doubly-encoded &amp;#8217; decodes too.
    .replace(/&#(\d+);/g, (ref, dec) => fromCodePoint(Number(dec), ref))
    .replace(/&#x([0-9a-f]+);/gi, (ref, hex) => fromCodePoint(parseInt(hex, 16), ref))
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
// dropped — a headline the DJ cannot read is not a headline. With `maxAgeDays`,
// an item dated older than that is dropped too, before the cap counts it: a
// search feed (Google News) ignores its own `when:` window on a long query and
// mixes months-old items in, and the DJ cannot tell last summer's festival from
// tonight's. An undated item is kept (fail open: nothing says it is stale).
export function parseFeed(xml: string, cap: number, { maxAgeDays = null, now = Date.now() }: ParseOptions = {}): Headline[] {
  let doc: Record<string, unknown> | null = null;
  try {
    doc = asRecord(parser.parse(xml));
  } catch {
    // Malformed XML — treat it as an empty feed rather than throwing into the
    // segment director, which is what the regex scanner did by construction.
    return [];
  }
  if (!doc) return [];

  const oldest = maxAgeDays ? now - maxAgeDays * 86_400_000 : null;
  const out: Headline[] = [];
  for (const entry of entriesOf(doc)) {
    if (out.length >= cap) break;
    const title = stripHtml(textOf(entry.title));
    if (!title) continue;
    const at = publishedOf(entry);
    if (oldest != null && at != null && at < oldest) continue;
    // RSS carries the blurb in <description>; Atom uses <summary>, falling back
    // to <content> (which, post-removeNSPrefix, is also where RSS's
    // <content:encoded> lands).
    const description = stripHtml(textOf(entry.description ?? entry.summary ?? entry.content));
    out.push(at == null ? { title, description } : { title, description, published: new Date(at).toISOString() });
  }
  return out;
}

export function hashHeadline(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  return h.toString(36);
}

export async function fetchHeadlines({ feedUrl, maxItems, maxAgeDays = null }: { feedUrl?: string; maxItems?: number; maxAgeDays?: number | null } = {}) {
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
  return parseFeed(await res.text(), cap, { maxAgeDays });
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
  feedMaxAgeDays: {
    type: 'number',
    label: 'Max age · days',
    min: 1,
    max: FEED_MAX_AGE_LIMIT,
    integer: true,
    placeholder: 'no limit',
    hint: 'Older items are skipped. Undated ones are kept.',
  },
  feed2: {
    type: 'url',
    label: 'Second feed URL · optional',
    placeholder: 'https://…/rss.xml',
    hint: 'Merged with the first feed.',
  },
  feed3: {
    type: 'url',
    label: 'Third feed URL · optional',
    placeholder: 'https://…/rss.xml',
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
  /** Further feeds merged with `url`; absent when none is declared. */
  extraUrls?: string[];
  /** Item age cap in days; absent when none is declared. */
  maxAgeDays?: number;
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
  const url = cleanUrl(config?.[FEED_URL_KEY]);
  const extras = FEED_EXTRA_URL_KEYS
    .map((key) => ({ key, url: cleanUrl(config?.[key]) }))
    .filter((e) => e.url);
  if (!url) {
    // A further feed with no first one is a half-filled form, not a feed.
    for (const e of extras) warnings.push(`${e.key}: set, but "${FEED_URL_KEY}" is empty — ignored`);
    return { feed: null, warnings };
  }

  const problem = urlProblem(url);
  if (problem) {
    warnings.push(`feed: "${url}" ${problem} — no feed tool was generated`);
    return { feed: null, warnings };
  }

  const feed: ResolvedFeed = { url, maxItems: resolveMaxItems(config?.[FEED_MAX_ITEMS_KEY], warnings) };
  // A bad further feed is skipped with a warning; the first one still works.
  const extraUrls: string[] = [];
  for (const e of extras) {
    const why = urlProblem(e.url);
    if (why) warnings.push(`${e.key}: "${e.url}" ${why} — skipped`);
    else if (e.url !== url && !extraUrls.includes(e.url)) extraUrls.push(e.url);
  }
  if (extraUrls.length) feed.extraUrls = extraUrls;
  const maxAgeDays = resolveMaxAge(config?.[FEED_MAX_AGE_KEY], warnings);
  if (maxAgeDays != null) feed.maxAgeDays = maxAgeDays;
  return { feed, warnings };
}

function cleanUrl(raw: unknown): string {
  return raw == null ? '' : String(raw).replace(/[\r\n\t]/g, '').trim();
}

function urlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a URL';
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? null : 'is not an http(s) URL';
}

// Lenient like `feedMaxItems`, but its fallback is "no limit": that is what a
// skill without the knob has always had.
function resolveMaxAge(raw: unknown, warnings: string[]): number | null {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > FEED_MAX_AGE_LIMIT) {
    warnings.push(`feedMaxAgeDays: "${raw}" is not a whole number between 1 and ${FEED_MAX_AGE_LIMIT} — no age limit applied`);
    return null;
  }
  return n;
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
// Returns the news shape, `{ headlines: [{ title, detail }] }`, when there is
// something fresh, and `{ available: false, reason }` when there is not — never
// an empty list (#1830). An empty list read as usable data to
// abstain-policy.ts, so Run now, a skill cron or a programme beat on a drained
// feed ordered a line with no items in it, and the model invented a headline.
// `available: false` is the shape every data tool already uses for "nothing
// worth airing", which stands those runs down and lets the pool path back off.
//
// `warn` reports a further feed that failed while another answered (the loader
// passes queue.log, so this module stays free of the queue): once per feed and
// error, again only after it has recovered, so a dead feed3 is one log line,
// not one per fire.
export function makeFeedTool(kind: string, feed: ResolvedFeed, warn: (message: string) => void = () => {}) {
  const reported = new Map<string, string>();
  const report = (failures: FeedFailure[], answered: string[]) => {
    for (const url of answered) reported.delete(url);
    for (const { url, error } of failures) {
      if (reported.get(url) === error) continue;
      reported.set(url, error);
      warn(`feed ${feedLabel(url)} failed and was skipped, the other feeds answered: ${error}`);
    }
  };
  return async function fetchFeedItems(_ctx?: unknown, state?: any) {
    const seen = seenSetFor(state, kind);
    const items = await fetchMerged(feed, report);
    // A feed that fetched fine but carries no readable items is the same
    // answer as one that has all aired. It touches no dedup memory.
    if (!items.length) return { available: false, reason: 'the feed has no items' };
    const fresh = items.filter(it => !seen.has(hashHeadline(it.title))).slice(0, FEED_ITEMS_PER_FIRE);
    if (!fresh.length) return { available: false, reason: 'every item on the feed has already aired' };
    // Burn on read so a later tick doesn't re-offer the same item.
    for (const it of fresh) seen.add(hashHeadline(it.title));
    if (seen.size > SEEN_HIGH_WATER) {
      const kept = Array.from(seen).slice(-SEEN_KEEP);
      seen.clear();
      for (const h of kept) seen.add(h);
    }
    // The date rides along when the feed gave one, so the DJ can tell what is
    // news from what is history (and never call an old event "coming up").
    return {
      headlines: fresh.map(it => (it.published
        ? { title: it.title, detail: it.description || null, published: zonedISODate(new Date(it.published)) }
        : { title: it.title, detail: it.description || null })),
    };
  };
}

interface FeedFailure { url: string; error: string }

// A feed named in a log line: host and path. The query is dropped, both for
// length (a news search lives there) and because a private feed's token can.
function feedLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'url';
  }
}

// Every declared feed, fetched together and interleaved round-robin so a busy
// feed cannot crowd a quiet one out; a repeated headline keeps its first
// appearance. `maxItems` is read from each feed and caps the merged list too,
// so a fire never offers more than one feed's worth, and the burn-on-read
// memory (SEEN_KEEP) always covers a whole list. A feed failing while another
// answers is reported; if the ones that answered had no items, the failure is
// the answer (rethrown), so a broken feed is never hidden behind an empty one.
// All of them failing rethrows the first error, the same `{ error }`
// degradation a single feed has always had.
async function fetchMerged(
  feed: ResolvedFeed,
  report: (failures: FeedFailure[], answered: string[]) => void = () => {},
): Promise<Headline[]> {
  const urls = [feed.url, ...(feed.extraUrls || [])];
  const opts = { maxItems: feed.maxItems, maxAgeDays: feed.maxAgeDays ?? null };
  if (urls.length === 1) return fetchHeadlines({ feedUrl: urls[0], ...opts });
  const results = await Promise.allSettled(urls.map((feedUrl) => fetchHeadlines({ feedUrl, ...opts })));
  const lists = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!lists.length || (firstFailure && !lists.some((l) => l.length))) throw firstFailure!.reason;
  report(
    results.flatMap((r, i) => (r.status === 'rejected'
      ? [{ url: urls[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
      : [])),
    urls.filter((_, i) => results[i].status === 'fulfilled'),
  );
  const out: Headline[] = [];
  const taken = new Set<string>();
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const it = list[i];
      if (!it) continue;
      const h = hashHeadline(it.title);
      if (taken.has(h)) continue;
      taken.add(h);
      out.push(it);
    }
  }
  return out.slice(0, feed.maxItems);
}
