// Web search helper — backs the `searchArtistNews` segment tool (llm/
// segment-tools.js). There is no standalone "web-search skill" object — the
// segment-director agent (skills/_agent.js) decides when artist news airs.
//
// Two backends, chosen via settings.search.provider:
//   - duckduckgo (default) — DuckDuckGo's Instant Answer API. Free, no key,
//     officially documented. Returns useful results only for entity / definition
//     queries; for most artist queries it returns nothing, which the segment
//     director already treats as a valid (silent) outcome.
//   - tavily — paid API for richer web results. Reads its key from
//     settings.search.apiKey, falling back to config.search.apiKey
//     (SEARCH_API_KEY env var) for back-compat with earlier installs.
//
// Both backends return the same shape — { answer, results: [{ title, content }] }
// — so callers don't have to branch. searchWeb() wraps every call in a 30-min
// memo to keep the homelab polite under DDG's unofficial fair-use limits and
// to avoid burning Tavily credits on duplicate ticks.

import { config } from '../config.js';
import * as settings from '../settings.js';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const DDG_ENDPOINT = 'https://api.duckduckgo.com/';

type SearchResult = { title: string; content: string };
type SearchResponse = { answer: string; results: SearchResult[] };

// 30-min TTL cache keyed by `${provider}:${query}`. Same shape as music/picker.js
// — Map + { val, at }, no LRU eviction (search queries are bounded by the
// artists actually on rotation, so the Map stays small).
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { val: SearchResponse; at: number }>();

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

export async function tavilySearch(query: string): Promise<SearchResponse> {
  const apiKey = settings.get().search?.apiKey || config.search.apiKey;
  const res = await fetch(TAVILY_ENDPOINT, {
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
export async function duckduckgoSearch(query: string): Promise<SearchResponse> {
  const url = new URL(DDG_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  url.searchParams.set('no_redirect', '1');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'SUB-WAVE radio controller (https://github.com/perminder-klair/subwave)',
    },
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

// Provider dispatcher — reads the active provider from live settings on every
// call so admin-UI changes take effect immediately. Wraps the backend in a
// 30-min memo so two ticks on the same artist don't issue two outbound calls.
export async function searchWeb(query: string): Promise<SearchResponse> {
  const provider = settings.get().search?.provider || 'duckduckgo';
  const key = `${provider}:${query.toLowerCase()}`;
  return memo(key, CACHE_TTL_MS, () => {
    if (provider === 'tavily') return tavilySearch(query);
    return duckduckgoSearch(query);
  });
}

// True when the active search provider is usable right now. DDG always is;
// Tavily needs a key (settings.search.apiKey, falling back to SEARCH_API_KEY).
// Imported by the capability gate in skills/_agent.js and the tool registration
// gate in llm/segment-tools.js so they agree on a single source of truth.
export function searchReady(): boolean {
  const s = settings.get().search;
  if (!s || s.provider === 'duckduckgo') return true;
  return !!(s.apiKey || config.search.apiKey);
}
