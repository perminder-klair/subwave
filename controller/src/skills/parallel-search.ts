// Parallel's anonymous MCP endpoint. Use the supported SDK for protocol and SSE
// handling; the shared search key slot is deliberately never read or sent.
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { cleanSnippet, type SearchResponse, type SearchResult } from './search-snippet.js';

const ENDPOINT = 'https://mcp.parallel.ai/mcp';
const USER_AGENT = 'SUB-WAVE radio controller (https://github.com/perminder-klair/subwave)';

// Parallel's excerpts are page text as markdown, and the first one often opens
// with the page's chrome: a breadcrumb, a menu, "Search for:", a dateline, an
// infobox. Cut at 300 characters as it came, a snippet could be all menu, and
// that is what reached the DJ's prompt. So each line is read on its own:
//   - plainly navigation (a short bare list item, a breadcrumb, a site label
//     such as "Search for:" or "Share", a row of share buttons, the "..."
//     between excerpts) is dropped wherever it is;
//   - an excerpt's leading lines are skipped until its first line of prose (a
//     sentence ending in . ! ? or a closing quote, or a line of 12 words or
//     more; never a list item or a table row). An excerpt with no prose line
//     is all chrome and is dropped, unless every excerpt is, when its
//     non-navigation lines stand.
// Then the same cleanup every provider gets (cleanSnippet, whitespace
// collapsed) and the 300-character cut. An excerpt that is already prose comes
// through unchanged apart from its whitespace.
const LIST_ITEM = /^\s*(?:[*+\-\u2022]|\d+[.)])(?=\s|$)\s*/u;
const SITE_LABEL = /^(?:search(?: for)?|skip to (?:main )?content|menu|share|appearance|now playing|advertisement|\.{3}|\u2026)\s*:?$/iu;
const SHARE_BUTTONS = new Set(['twitter', 'x', 'facebook', 'pinterest', 'linkedin', 'reddit', 'whatsapp', 'email', 'bluesky', 'threads', 'tumblr']);
const SENTENCE_END = /(?:[!?]|(?<!\.\.)\.|["\u201d\u2019'])$/u;

function wordCount(line: string): number {
  return (line.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

// Markdown down to its words: link and image syntax, heading and quote marks,
// emphasis runs. The text the markup carried stays.
function unmark(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|>)\s*/, '')
    .replace(/(?:\*\*|__|_{3,})/g, '')
    .replace(/(?<![\p{L}\p{N}])[*_]([^*_]+)[*_](?![\p{L}\p{N}])/gu, '$1')
    .trim();
}

function isShareRow(line: string): boolean {
  return line.split(/\s+/).every(w => SHARE_BUTTONS.has(w.toLowerCase()));
}

function isNavigation(line: string, listItem: boolean): boolean {
  if (!line || SITE_LABEL.test(line) || isShareRow(line)) return true;
  if ((line.match(/ > /g) ?? []).length >= 2) return true; // breadcrumb
  return listItem && wordCount(line) <= 5 && !SENTENCE_END.test(line);
}

// A line that opens in lower case continues the one above it (hard-wrapped
// prose), so the two are judged as one.
function unwrap(excerpt: string): string[] {
  const lines: string[] = [];
  for (const raw of excerpt.split(/\r?\n/)) {
    const prev = lines.length - 1;
    if (prev >= 0 && lines[prev].trim() && /^\s*\p{Ll}/u.test(raw)) lines[prev] += ` ${raw.trim()}`;
    else lines.push(raw);
  }
  return lines;
}

function excerptLines(excerpt: string): { text: string; prose: boolean }[] {
  const out: { text: string; prose: boolean }[] = [];
  for (const raw of unwrap(excerpt)) {
    const listItem = LIST_ITEM.test(raw);
    const text = unmark(raw.replace(LIST_ITEM, ''));
    if (isNavigation(text, listItem)) continue;
    // A table row or a byline ("Published … | Editor …") is never the prose start.
    const prose = !listItem && !/\s\|(?:\s|$)/.test(text)
      && (SENTENCE_END.test(text) || wordCount(text) >= 12);
    out.push({ text, prose });
  }
  return out;
}

export function parallelSnippet(excerpts: string[]): string {
  const kept: string[] = [];
  const fallback: string[] = [];
  for (const excerpt of excerpts) {
    const lines = excerptLines(excerpt);
    fallback.push(...lines.map(l => l.text));
    const first = lines.findIndex(l => l.prose);
    if (first >= 0) kept.push(...lines.slice(first).map(l => l.text));
  }
  return cleanSnippet((kept.length ? kept : fallback).join(' ')).replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function parseParallelResponse(data: unknown): SearchResponse {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).results : null;
  const results: SearchResult[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const title = cleanSnippet(r.title).replace(/\s+/g, ' ').trim();
    const content = Array.isArray(r.excerpts)
      ? parallelSnippet(r.excerpts.filter((v): v is string => typeof v === 'string'))
      : '';
    if (!title || !content) continue;
    results.push({ title, content });
    if (results.length >= 5) break;
  }
  return { answer: '', results };
}

export async function parallelSearch(
  query: string,
  recency?: 'day' | 'week' | 'month',
): Promise<SearchResponse> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { 'User-Agent': USER_AGENT } },
    // Global fetch owns the connection pool; this adapter owns no dispatcher.
    // Bound teardown too, without allowing it to replace the search outcome.
    fetch: (input, init) => fetchWithTimeout(input, {
      ...init, timeoutMs: init?.method === 'DELETE' ? 2_000 : 30_000, bodyDeadline: true,
    }),
  });
  const client = new Client({ name: 'subwave', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 30_000 });
    const tools = await client.listTools({}, { timeout: 30_000 });
    if (!tools.tools.some(t => t.name === 'web_search')) throw new Error('Parallel web_search unavailable');
    const result = CallToolResultSchema.parse(await client.callTool({
      name: 'web_search',
      arguments: {
        objective: recency ? `${query}\nPrefer sources from the past ${recency}.` : query,
        search_queries: [query],
      },
    }, undefined, { timeout: 30_000 }));
    if (result.isError) throw new Error(`Parallel search failed: ${JSON.stringify(result.content)}`);
    let data: unknown = result.structuredContent;
    if (!data) {
      const text = result.content.find(c => c.type === 'text');
      if (text?.type === 'text') data = JSON.parse(text.text);
    }
    return parseParallelResponse(data);
  } finally {
    try { if (transport.sessionId) await transport.terminateSession(); } catch { /* best effort */ }
    await client.close();
  }
}
