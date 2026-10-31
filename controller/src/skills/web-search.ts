// All providers return { answer, results: [{ title, content }] } behind a 30-minute memo.
// DDG instant answers may be empty; Tavily/Brave need keys; SearXNG needs a base URL;
// Keenable is keyless, with an optional key that raises its rate limit; Firecrawl needs a key.
// Brave supports artist-name queries (#623); searxngEngines pins only these calls (#1353).

import { config } from '../config.js';
import * as settings from '../settings.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { BoundedKeyMap } from '../util/bounded-key-map.js';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const DDG_ENDPOINT = 'https://api.duckduckgo.com/';
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const KEENABLE_ENDPOINT = 'https://api.keenable.ai/v1/search';
const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/search';

type SearchResult = { title: string; content: string };
type SearchResponse = { answer: string; results: SearchResult[] };

// 30-min TTL cache keyed by `${provider}:${query}`. BOUNDED: the request path's
// identifyRequestedTrack searches on a listener's free-text description, so the
// key space is open-ended. Expired entries go first when the cap is reached, then
// the least recently written.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_KEYS = 256;
const cache = new BoundedKeyMap<{ val: SearchResponse; at: number }>({
  maxKeys: CACHE_MAX_KEYS,
  isLive: (rec, now) => now - rec.at < CACHE_TTL_MS,
});

// Test seam.
export function searchCacheSize(): number {
  return cache.size;
}

async function memo(
  key: string,
  ttl: number,
  fn: () => Promise<SearchResponse>,
): Promise<SearchResponse> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = await fn();
  cache.set(key, { val, at: Date.now() });
  return val;
}

// The one key slot every keyed backend reads: the saved settings.search.apiKey,
// else SEARCH_API_KEY from the environment. `source` says which, for the admin.
export function searchKeySlot(): { key: string; source: 'settings' | 'env' | null } {
  const saved = settings.get().search?.apiKey;
  if (saved) return { key: saved, source: 'settings' };
  const env = process.env.SEARCH_API_KEY || config.search.apiKey;
  return env ? { key: env, source: 'env' } : { key: '', source: null };
}

export async function tavilySearch(query: string): Promise<SearchResponse> {
  const apiKey = searchKeySlot().key;
  const res = await fetchWithTimeout(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      topic: 'general',
      include_answer: true,
      max_results: 5,
    }),
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data: any = await res.json();
  return {
    answer: String(data.answer || '').trim(),
    results: Array.isArray(data.results)
      ? data.results.map((r: any) => ({
          title: String(r.title || ''),
          content: String(r.content || ''),
        }))
      : [],
  };
}

// DuckDuckGo Instant Answer API. Returns sparse results — useful for well-known
// entities (artists with a Wikipedia infobox, common nouns) and silent for most
// other queries. We map `AbstractText` to the answer slot, and prefer
// `RelatedTopics[*].Text` for sources.
//
// Setting `no_html=1` strips HTML from AbstractText/RelatedTopics; `skip_disambig=1`
// avoids the "did you mean…" disambiguation pages, which never contain useful
// detail. We send a real User-Agent — DDG silently 200s with an empty body
// otherwise.
//
// The deadline matters more here than on the other backends: this is the
// DEFAULT provider (see searchWeb below), and DDG is known to accept a
// connection and then hold it, which without a timeout parks the request on
// undici's ~300s default. memo() only caches AFTER the call resolves, so
// concurrent duplicate queries each open their own socket rather than sharing
// one.
export async function duckduckgoSearch(query: string): Promise<SearchResponse> {
  const url = new URL(DDG_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  url.searchParams.set('no_redirect', '1');
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'SUB-WAVE radio controller (https://github.com/perminder-klair/subwave)',
    },
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const data: any = await res.json();
  const answer = String(data.AbstractText || data.Abstract || '').trim();
  const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  const results: SearchResult[] = [];
  for (const t of topics) {
    if (!t) continue;
    if (Array.isArray(t.Topics)) {
      // Grouped category — flatten one level deep.
      for (const sub of t.Topics) {
        if (sub && typeof sub.Text === 'string' && sub.Text.trim()) {
          results.push({
            title: String(sub.Name || data.Heading || ''),
            content: sub.Text.trim(),
          });
        }
        if (results.length >= 5) break;
      }
    } else if (typeof t.Text === 'string' && t.Text.trim()) {
      results.push({
        title: String(t.Name || data.Heading || ''),
        content: t.Text.trim(),
      });
    }
    if (results.length >= 5) break;
  }
  return { answer, results: results.slice(0, 5) };
}

// SearXNG meta-search backend. Self-hosted, no API key — needs only a
// reachable base URL stored in settings.search.baseUrl. Threads optional
// recency through to SearXNG's time_range param (artist-news callsite
// passes 'week' to bias toward fresh content).
export async function searxngSearch(
  query: string,
  recency?: 'day' | 'week' | 'month',
): Promise<SearchResponse> {
  const baseUrl = (settings.get().search?.baseUrl || '').trim();
  if (!baseUrl) throw new Error('SearXNG baseUrl not configured');

  const url = buildSearxngUrl({
    baseUrl,
    query,
    recency,
    engines: settings.get().search?.searxngEngines || '',
  });

  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'SUB-WAVE radio controller (https://github.com/perminder-klair/subwave)',
    },
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  return parseSearxngResponse(data);
}

// Pure URL builder for a SearXNG query. Exported alongside parseSearxngResponse
// so the query shape can be pinned without mocking fetch.
//
// `engines` is the optional operator pin (settings.search.searxngEngines, #1353):
// a comma-separated list of SearXNG `name:` fields, sent as SearXNG's per-request
// `engines=` param so one instance can serve a narrow, deterministic engine set
// to the controller while browser traffic keeps the instance-wide defaults.
// Empty means the param is omitted entirely — the pre-#1353 behaviour.
export function buildSearxngUrl(opts: {
  baseUrl: string;
  query: string;
  recency?: 'day' | 'week' | 'month';
  engines?: string;
}): URL {
  const url = new URL('/search', opts.baseUrl);
  url.searchParams.set('q', opts.query);
  url.searchParams.set('format', 'json');
  if (opts.recency) url.searchParams.set('time_range', opts.recency);
  const engines = (opts.engines || '').trim();
  if (engines) url.searchParams.set('engines', engines);
  return url;
}

// Pure parser for SearXNG's JSON response. Maps the SearXNG shape
// (results[], answers[], infoboxes[]) onto SubWave's SearchResponse contract.
// Exported separately from searxngSearch() so fixture-based tests can pin
// the mapping without mocking fetch. Tolerant of malformed input — any
// shape mismatch yields { answer: '', results: [] }.
export function parseSearxngResponse(data: unknown): SearchResponse {
  if (!data || typeof data !== 'object') return { answer: '', results: [] };
  const d = data as Record<string, unknown>;

  // answer slot: prefer first infobox content, else empty.
  let answer = '';
  const infoboxes = Array.isArray(d.infoboxes) ? d.infoboxes : [];
  if (infoboxes.length > 0 && infoboxes[0] && typeof infoboxes[0] === 'object') {
    const ib = infoboxes[0] as Record<string, unknown>;
    if (typeof ib.content === 'string') answer = ib.content.trim();
  }

  const rawResults = Array.isArray(d.results) ? d.results : [];
  const results: SearchResult[] = [];
  for (const r of rawResults) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const content = typeof rec.content === 'string' ? rec.content.trim().slice(0, 300) : '';
    if (!title || !content) continue;
    results.push({ title, content });
    if (results.length >= 10) break;
  }

  return { answer, results };
}

// Brave Search API backend (issue #623). Keyed like Tavily — the key lives in
// settings.search.apiKey with SEARCH_API_KEY as the env fallback. Threads
// optional recency through Brave's `freshness` param (pd/pw/pm), and asks for
// undecorated snippets (text_decorations=0) so descriptions arrive as plain
// text instead of <strong>-highlighted HTML.
export async function braveSearch(
  query: string,
  recency?: 'day' | 'week' | 'month',
): Promise<SearchResponse> {
  const apiKey = searchKeySlot().key;
  if (!apiKey) throw new Error('Brave Search API key not configured');

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', '10');
  url.searchParams.set('text_decorations', '0');
  if (recency) {
    url.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm' }[recency]);
  }

  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
  const data = await res.json();
  return parseBraveResponse(data);
}

// Strips residual markup from Brave snippets. text_decorations=0 removes the
// highlighting, but descriptions can still carry entities (&#x27; etc.) and
// the occasional stray tag depending on the source page.
function braveText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (whole, x: string, digits: string) => {
      const code = parseInt(digits, x ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

// Pure parser for Brave's web-search JSON. Maps the Brave shape (web.results[],
// news.results[], infobox) onto SubWave's SearchResponse contract. News results
// lead — the artist-news callsite is the whole point of this provider — then
// web results fill the remainder. Exported separately from braveSearch() so
// fixture-based tests can pin the mapping without mocking fetch. Tolerant of
// malformed input — any shape mismatch yields { answer: '', results: [] }.
export function parseBraveResponse(data: unknown): SearchResponse {
  if (!data || typeof data !== 'object') return { answer: '', results: [] };
  const d = data as Record<string, unknown>;
  const sub = (v: unknown, key: string): unknown =>
    v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;

  // answer slot: the infobox's long description when Brave recognises the
  // entity. `infobox.results` has been observed as both an object and a
  // one-element array — accept either.
  const ibRaw = sub(d.infobox, 'results');
  const ib = Array.isArray(ibRaw) ? ibRaw[0] : ibRaw;
  const answer = braveText(sub(ib, 'long_desc') || sub(ib, 'description'));

  const results: SearchResult[] = [];
  const push = (r: unknown) => {
    if (!r || typeof r !== 'object' || results.length >= 10) return;
    const rec = r as Record<string, unknown>;
    const title = braveText(rec.title);
    const content = braveText(rec.description).slice(0, 300);
    if (!title || !content) return;
    results.push({ title, content });
  };
  const newsResults = sub(d.news, 'results');
  const webResults = sub(d.web, 'results');
  for (const r of Array.isArray(newsResults) ? newsResults : []) push(r);
  for (const r of Array.isArray(webResults) ? webResults : []) push(r);

  return { answer, results };
}

// Keenable backend. Keyless by default: without a key the call goes to the
// public endpoint, which is free and rate limited per IP. A Keenable key
// (`keen_…`) in the shared settings.search.apiKey / SEARCH_API_KEY slot moves
// it to the keyed endpoint and raises that limit. The slot may still hold a
// Tavily or Brave key from an earlier provider, so only a `keen_` value is
// sent; anything else keeps the call keyless rather than failing it.
export async function keenableSearch(
  query: string,
  recency?: 'day' | 'week' | 'month',
): Promise<SearchResponse> {
  const apiKey = searchKeySlot().key;
  const { url, init } = buildKeenableRequest({ query, apiKey, recency });
  const res = await fetchWithTimeout(url, { ...init, timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`Keenable HTTP ${res.status}`);
  const data = await res.json();
  return parseKeenableResponse(data);
}

// The one test for "is this a Keenable key": the request builder, the admin
// key probe and keenableKeySource all ask it.
export function isKeenableKey(key: string): boolean {
  return key.trim().startsWith('keen_');
}

// Where the key a Keenable search would send comes from, or null when it runs
// keyless. SEARCH_API_KEY being set can't say whose key it is, so GET
// /settings serves this to show a Keenable key that lives only in .env.
export function keenableKeySource(): 'settings' | 'env' | null {
  const { key, source } = searchKeySlot();
  return isKeenableKey(key) ? source : null;
}

// Pure request builder for a Keenable search. Exported alongside
// parseKeenableResponse so endpoint, headers and body can be pinned without
// mocking fetch. `X-Keenable-Title` is required on the keyless endpoint (it
// answers 400 without it) and names the app on both. Recency becomes a
// `published_after` date; pages with no known publish date can still come back.
export function buildKeenableRequest(opts: {
  query: string;
  apiKey?: string;
  recency?: 'day' | 'week' | 'month';
  now?: Date;
}): { url: string; init: RequestInit } {
  const apiKey = (opts.apiKey || '').trim();
  const keyed = isKeenableKey(apiKey);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Keenable-Title': 'subwave',
  };
  if (keyed) headers['X-API-Key'] = apiKey;

  const body: Record<string, unknown> = {
    query: opts.query,
    max_results: 5,
    snippet_max_length: 300,
  };
  if (opts.recency) {
    const days = { day: 1, week: 7, month: 30 }[opts.recency];
    const since = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000);
    body.published_after = since.toISOString().slice(0, 10);
  }

  return {
    url: keyed ? KEENABLE_ENDPOINT : `${KEENABLE_ENDPOINT}/public`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  };
}

// Pure parser for Keenable's search JSON (results[] of title/url/snippet/
// description). The page text is in `snippet`; `description` is usually an
// empty string, so the pick is on emptiness, not presence. Snippets keep the
// page's line breaks, so whitespace is collapsed before the 300-char cap the
// other parsers use. There is no answer field. Tolerant of malformed input:
// any shape mismatch yields { answer: '', results: [] }.
export function parseKeenableResponse(data: unknown): SearchResponse {
  if (!data || typeof data !== 'object') return { answer: '', results: [] };
  const raw = (data as Record<string, unknown>).results;

  const text = (v: unknown): string =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  const results: SearchResult[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const title = text(rec.title);
    const content = (text(rec.snippet) || text(rec.description)).slice(0, 300);
    if (!title || !content) continue;
    results.push({ title, content });
    if (results.length >= 5) break;
  }

  return { answer: '', results };
}

// Firecrawl backend. Keyed via the shared settings.search.apiKey /
// SEARCH_API_KEY slot (same resolution as Tavily and Brave). Threads optional
// recency through Firecrawl's `tbs` param (qdr:d/w/m).
export async function firecrawlSearch(
  query: string,
  recency?: 'day' | 'week' | 'month',
): Promise<SearchResponse> {
  const apiKey = searchKeySlot().key;
  if (!apiKey) throw new Error('Firecrawl API key not configured');
  const { url, init } = buildFirecrawlRequest({ query, apiKey, recency });
  const res = await fetchWithTimeout(url, { ...init, timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  const data = await res.json();
  return parseFirecrawlResponse(data);
}

// Pure request builder for a Firecrawl search, exported so endpoint, headers
// and body can be pinned without mocking fetch.
export function buildFirecrawlRequest(opts: {
  query: string;
  apiKey: string;
  recency?: 'day' | 'week' | 'month';
}): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = { query: opts.query, limit: 5 };
  if (opts.recency) body.tbs = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m' }[opts.recency];
  return {
    url: FIRECRAWL_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey.trim()}` },
      body: JSON.stringify(body),
    },
  };
}

// Pure parser for Firecrawl's search JSON (data.web[] of url/title/
// description). Descriptions can carry HTML entities, so they go through the
// same cleanup as Brave's, then whitespace is collapsed before the 300-char
// cap. There is no answer field. Any shape mismatch yields { answer: '', results: [] }.
export function parseFirecrawlResponse(data: unknown): SearchResponse {
  if (!data || typeof data !== 'object') return { answer: '', results: [] };
  const inner = (data as Record<string, unknown>).data;
  const raw = inner && typeof inner === 'object' ? (inner as Record<string, unknown>).web : undefined;

  const text = (v: unknown): string => braveText(v).replace(/\s+/g, ' ').trim();
  const results: SearchResult[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const title = text(rec.title);
    const content = text(rec.description).slice(0, 300);
    if (!title || !content) continue;
    results.push({ title, content });
    if (results.length >= 5) break;
  }

  return { answer: '', results };
}

// Provider dispatcher — reads the active provider from live settings on every
// call so admin-UI changes take effect immediately. Wraps the backend in a
// 30-min memo. Cache key includes recency so two callsites with different
// recency hints don't share results.
export async function searchWeb(
  query: string,
  opts?: { recency?: 'day' | 'week' | 'month' },
): Promise<SearchResponse> {
  const provider = settings.get().search?.provider || 'duckduckgo';
  const recency = opts?.recency;
  const key = `${provider}:${recency || ''}:${query.toLowerCase()}`;
  return memo(key, CACHE_TTL_MS, () => {
    if (provider === 'searxng') return searxngSearch(query, recency);
    if (provider === 'tavily') return tavilySearch(query);
    if (provider === 'brave') return braveSearch(query, recency);
    if (provider === 'keenable') return keenableSearch(query, recency);
    if (provider === 'firecrawl') return firecrawlSearch(query, recency);
    return duckduckgoSearch(query);
  });
}

// True when the active search provider is usable right now.
//   duckduckgo:   always ready (no key, no URL)
//   keenable:     always ready (keyless; a key only raises the rate limit)
//   tavily/brave/firecrawl: needs settings.search.apiKey, or SEARCH_API_KEY env
//   searxng:      needs settings.search.baseUrl (no env fallback by design)
export function searchReady(): boolean {
  const s = settings.get().search;
  const provider = s?.provider || 'duckduckgo';
  if (provider === 'duckduckgo' || provider === 'keenable') return true;
  if (provider === 'searxng') return !!(s?.baseUrl && s.baseUrl.trim());
  // tavily / brave / firecrawl (and any future keyed provider)
  return !!searchKeySlot().key;
}
