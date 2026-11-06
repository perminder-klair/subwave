// Parallel's anonymous MCP endpoint. Use the supported SDK for protocol and SSE
// handling; the shared search key slot is deliberately never read or sent.
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';

const ENDPOINT = 'https://mcp.parallel.ai/mcp';
const USER_AGENT = 'SUB-WAVE radio controller (https://github.com/perminder-klair/subwave)';

export function parseParallelResponse(data: unknown): {
  answer: string;
  results: { title: string; content: string; url: string }[];
} {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).results : null;
  const results: { title: string; content: string; url: string }[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const url = typeof r.url === 'string' ? r.url : '';
    const content = Array.isArray(r.excerpts)
      ? r.excerpts.filter((v): v is string => typeof v === 'string').join('\n').trim().slice(0, 300)
      : '';
    if (!title || !content) continue;
    results.push({ title, content, url });
    if (results.length >= 5) break;
  }
  return { answer: '', results };
}

export async function parallelSearch(query: string, recency?: 'day' | 'week' | 'month') {
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
