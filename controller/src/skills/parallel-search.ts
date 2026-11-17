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
//   - plainly navigation (a short bare list item with no figure in it, a
//     breadcrumb, a site label such as "Search for:" or "Share", a row of share
//     buttons, the "..." between excerpts) is dropped wherever it is;
//   - an excerpt's leading lines are skipped until its first line of prose (a
//     sentence ending in . ! ? or a closing quote, or a line of 12 words or
//     more; never a list item or a table row). An excerpt with no prose line
//     is all chrome and is dropped, unless every excerpt is, when its
//     non-navigation lines stand, and if there are none of those either (a
//     result that is only a list: a tracklist, a discography) its short list
//     items do, rather than the result being lost.
// CJK text has no spaces, so each two Han or kana characters count as a word
// (Japanese averages about two a word), and
// 。！？ and closing 」』 end a sentence.
// Then the same cleanup every provider gets (cleanSnippet, whitespace
// collapsed) and the 300-character cut. Every regex here runs on page text,
// so each stays linear: bracket and paren runs stop at the next opener, and
// the shared cleanup sees a bounded head of the text, never the whole page. An excerpt that is already prose comes
// through unchanged apart from its whitespace.
const LIST_ITEM = /^\s*(?:[*+\-\u2022]|\d+[.)])(?=\s|$)\s*/u;
const SITE_LABEL = /^(?:search(?: for)?|skip to (?:main )?content|menu|share|appearance|now playing|advertisement|\.{3}|\u2026)\s*:?$/iu;
const SHARE_BUTTONS = new Set(['twitter', 'x', 'facebook', 'pinterest', 'linkedin', 'reddit', 'whatsapp', 'email', 'bluesky', 'threads', 'tumblr']);
const SENTENCE_END = /(?:[!?\u3002\uff01\uff1f]|(?<!\.\.)\.|["\u201d\u2019'\u300d\u300f])$/u;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
// Text past this many characters cannot reach a 300-character snippet once
// the cleanup has removed markup, and it bounds the shared cleanup's cost.
const CLEANUP_INPUT_MAX = 2_000;

function wordCount(line: string): number {
  let n = 0;
  for (const word of line.match(/[\p{L}\p{N}]+/gu) ?? []) n += Math.ceil((word.match(CJK_CHAR) ?? []).length / 2) || 1;
  return n;
}

// Markdown down to its words: link and image syntax, heading and quote marks,
// emphasis runs. The text the markup carried stays.
function unmark(line: string): string {
  return line
    .replace(/!\[[^\][]*\]\((?:[^()]|\([^()]*\))*\)/g, '')
    .replace(/\[([^\][]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|>)\s*/, '')
    .replace(/(?:\*\*|__|_{3,})/g, '')
    .replace(/(?<![\p{L}\p{N}])[*_]([^*_]+)[*_](?![\p{L}\p{N}])/gu, '$1')
    .trim();
}

function isShareRow(line: string): boolean {
  return line.split(/\s+/).every(w => SHARE_BUTTONS.has(w.toLowerCase()));
}

// 'chrome' is dropped outright; 'short-item' (a short bare list item, a menu
// entry or a track title alike) is kept only when nothing else is left.
function navigation(line: string, listItem: boolean): 'chrome' | 'short-item' | null {
  if (!line || SITE_LABEL.test(line) || isShareRow(line)) return 'chrome';
  if ((line.match(/ > /g) ?? []).length >= 2) return 'chrome'; // breadcrumb
  // A figure (a date, a year, a chart place) is data, not a menu entry.
  if (listItem && wordCount(line) <= 5 && !SENTENCE_END.test(line) && !/\p{N}/u.test(line)) return 'short-item';
  return null;
}

// A line that opens in lower case continues the one above it (hard-wrapped
// prose), so the two are judged as one.
// Each line's parts are joined once at the end: appending to a growing string
// and re-reading it per line is quadratic in a page of short lines.
function unwrap(excerpt: string): string[] {
  const lines: string[][] = [];
  let prevHasText = false;
  for (const raw of excerpt.split(/\r?\n/)) {
    if (prevHasText && /^\s*\p{Ll}/u.test(raw)) lines[lines.length - 1].push(raw.trim());
    else { lines.push([raw]); prevHasText = /\S/.test(raw); }
  }
  return lines.map(parts => parts.join(' '));
}

function excerptLines(excerpt: string): { text: string; prose: boolean; shortItem: boolean }[] {
  const out: { text: string; prose: boolean; shortItem: boolean }[] = [];
  for (const raw of unwrap(excerpt)) {
    const listItem = LIST_ITEM.test(raw);
    const text = unmark(raw.replace(LIST_ITEM, ''));
    const nav = navigation(text, listItem);
    if (nav === 'chrome') continue;
    // A table row or a byline ("Published … | Editor …") is never the prose start.
    const prose = !nav && !listItem && !/\s\|(?:\s|$)/.test(text)
      && (SENTENCE_END.test(text) || wordCount(text) >= 12);
    out.push({ text, prose, shortItem: nav === 'short-item' });
  }
  return out;
}

export function parallelSnippet(excerpts: string[]): string {
  const kept: string[] = [];
  const fallback: string[] = [];
  const shortItems: string[] = [];
  for (const excerpt of excerpts) {
    const lines = excerptLines(excerpt);
    for (const l of lines) (l.shortItem ? shortItems : fallback).push(l.text);
    const first = lines.findIndex(l => l.prose);
    if (first >= 0) kept.push(...lines.slice(first).filter(l => !l.shortItem).map(l => l.text));
  }
  const text = (kept.length ? kept : fallback.length ? fallback : shortItems).join(' ');
  return cleanText(text.replace(/\s+/g, ' ').slice(0, CLEANUP_INPUT_MAX)).slice(0, 300);
}

function cleanText(raw: string): string {
  return cleanSnippet(raw).replace(/\s+/g, ' ').trim();
}

export function parseParallelResponse(data: unknown): SearchResponse {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).results : null;
  const results: SearchResult[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const title = typeof r.title === 'string' ? cleanText(r.title.replace(/\s+/g, ' ').slice(0, CLEANUP_INPUT_MAX)) : '';
    const content = Array.isArray(r.excerpts)
      ? parallelSnippet(r.excerpts.filter((v): v is string => typeof v === 'string'))
      : '';
    if (!title || !content) continue;
    results.push({ title, content });
    if (results.length >= 5) break;
  }
  return { answer: '', results };
}

// What a failed tool call said, as text and capped: the message lands in logs
// and the booth log, and the server decides how long it is.
const ERROR_TEXT_MAX = 200;

function toolErrorText(content: { type: string; text?: unknown }[]): string {
  const text = content
    .map(c => (c.type === 'text' && typeof c.text === 'string' ? c.text : `[${c.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return 'no detail';
  return text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX)}…` : text;
}

// One deadline for the whole search, the 30 s every other provider gets for
// its one request: connect, the tool listing and the call all spend from it,
// so a server that stalls at any step ends the search there, rather than each
// step running its own 30 s. Closing the session afterwards is bounded apart
// (2 s) and never replaces the search's own outcome.
const SEARCH_DEADLINE_MS = 30_000;
const TEARDOWN_TIMEOUT_MS = 2_000;

export async function parallelSearch(
  query: string,
  recency?: 'day' | 'week' | 'month',
  { deadlineMs = SEARCH_DEADLINE_MS }: { deadlineMs?: number } = {}, // test seam
): Promise<SearchResponse> {
  const deadline = AbortSignal.timeout(deadlineMs);
  const step = { signal: deadline, timeout: deadlineMs };
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { 'User-Agent': USER_AGENT } },
    // Global fetch owns the connection pool; this adapter owns no dispatcher.
    fetch: (input, init) => init?.method === 'DELETE'
      ? fetchWithTimeout(input, { ...init, timeoutMs: TEARDOWN_TIMEOUT_MS, bodyDeadline: true })
      : fetchWithTimeout(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
        timeoutMs: deadlineMs,
        bodyDeadline: true,
      }),
  });
  const client = new Client({ name: 'subwave', version: '1.0.0' });
  try {
    await client.connect(transport, step);
    const tools = await client.listTools({}, step);
    if (!tools.tools.some(t => t.name === 'web_search')) throw new Error('Parallel web_search unavailable');
    const result = CallToolResultSchema.parse(await client.callTool({
      name: 'web_search',
      arguments: {
        objective: recency ? `${query}\nPrefer sources from the past ${recency}.` : query,
        search_queries: [query],
      },
    }, undefined, step));
    if (result.isError) throw new Error(`Parallel search failed: ${toolErrorText(result.content)}`);
    let data: unknown = result.structuredContent;
    if (!data) {
      const text = result.content.find(c => c.type === 'text');
      if (text?.type === 'text') data = JSON.parse(text.text);
    }
    return parseParallelResponse(data);
  } catch (err) {
    if (deadline.aborted) throw new Error(`Parallel search timed out after ${deadlineMs / 1000}s`, { cause: err });
    throw err;
  } finally {
    try { if (transport.sessionId) await transport.terminateSession(); } catch { /* best effort */ }
    await client.close();
  }
}
