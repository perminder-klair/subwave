// Synthetic MCP responses; the live search capture is kept outside the patch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import * as settings from '../src/settings.js';
import { setCache } from '../src/settings/store.js';
import { searchReady, searchWeb } from '../src/skills/web-search.js';
import { parallelSearch, parseParallelResponse } from '../src/skills/parallel-search.js';

const UA = 'SUB-WAVE radio controller (https://github.com/perminder-klair/subwave)';
const passage = 'A passage with \u0085 and \u2028 and \u2029 intact.';
const data = { results: [{ title: 'Music source', url: 'https://example.org/music', excerpts: [passage] }] };

test('parser preserves passages, limits results and tolerates malformed data', () => {
  assert.deepEqual(parseParallelResponse(data).results, [
    { title: 'Music source', content: passage, url: 'https://example.org/music' },
  ]);
  assert.deepEqual(parseParallelResponse(null), { answer: '', results: [] });
  assert.deepEqual(parseParallelResponse({ results: [null, {}, 4] }).results, []);
  assert.equal(parseParallelResponse({ results: Array(10).fill(data.results[0]) }).results.length, 5);
  assert.equal(parseParallelResponse({ results: [{ title: 'A', excerpts: ['x'.repeat(900)] }] }).results[0].content.length, 300);
});

test('Parallel selection survives cold load; existing providers and credentials keep their policy', async () => {
  const original = structuredClone(settings.get().search);
  try {
    await settings.update({ search: { provider: 'parallel', apiKey: 'tvly-do-not-send' } });
    setCache(null);
    await settings.load();
    assert.equal(settings.get().search.provider, 'parallel');
    assert.equal(searchReady(), true);
    for (const provider of ['duckduckgo', 'keenable']) {
      await settings.update({ search: { provider } });
      assert.equal(searchReady(), true);
    }
    await settings.update({ search: { provider: 'firecrawl', apiKey: '' } });
    assert.equal(searchReady(), false);
    await settings.update({ search: { provider: 'firecrawl', apiKey: 'tvly-wrong' } });
    assert.equal(searchReady(), false);
    await settings.update({ search: { provider: 'searxng', baseUrl: '' } });
    assert.equal(searchReady(), false);
  } finally { await settings.update({ search: original }); }
});

test('SDK wire path, headers, held-open replies, cleanup, errors and dispatcher cache', async () => {
  const realFetch = globalThis.fetch;
  const original = structuredClone(settings.get().search);
  let failed = false;
  let toolError = false;
  let httpError = false;
  let teardownFailed = false;
  let toolCalls = 0;
  let closed = 0;
  const seen: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['user-agent'], UA);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['x-api-key'], undefined);
    if (req.method === 'GET') { seen.push('GET'); res.writeHead(405).end(); return; }
    if (req.method === 'DELETE') { seen.push('DELETE'); res.writeHead(teardownFailed ? 500 : 200).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    seen.push(rpc.method);
    if (httpError) { res.writeHead(429).end('synthetic rate limit'); return; }
    if (!('id' in rpc)) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (rpc.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } };
      res.setHeader('mcp-session-id', 'synthetic-session');
    } else if (rpc.method === 'tools/list') {
      result = { tools: [{ name: 'web_search', inputSchema: { type: 'object' } }] };
    } else {
      toolCalls++;
      bodies.push(rpc.params.arguments);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'synthetic' } })}\r\n\r\n`);
      const response = failed
        ? { error: { code: -32042, message: 'synthetic primary error' } }
        : { result: { isError: toolError, content: [{ type: 'text', text: toolError ? 'synthetic tool failure' : JSON.stringify(data) }] } };
      res.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...response })}\r\n\r\n`);
      // Never send EOF: successful resolution AND socket closure are required.
      res.on('close', () => { closed++; });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  globalThis.fetch = ((input, init) => {
    assert.equal(String(input), 'https://mcp.parallel.ai/mcp');
    return realFetch(`http://127.0.0.1:${port}/mcp`, init);
  }) as typeof fetch;
  try {
    await settings.update({ search: { provider: 'parallel', apiKey: 'tvly-do-not-send' } });
    const start = Date.now();
    const response = await searchWeb('Sabrina Carpenter artist tour news', { recency: 'week' });
    assert.ok(Date.now() - start < 3_000);
    assert.equal(response.results[0].content, passage);
    assert.equal((response.results[0] as { url?: string }).url, 'https://example.org/music');
    await searchWeb('Sabrina Carpenter artist tour news', { recency: 'week' });
    assert.equal(toolCalls, 1, 'dispatcher memo preserved');
    assert.match(String(bodies[0].objective), /past week/);
    assert.deepEqual(bodies[0].search_queries, ['Sabrina Carpenter artist tour news']);
    teardownFailed = true;
    assert.equal((await parallelSearch('cleanup failure')).results[0].content, passage);
    failed = true;
    const errorStart = Date.now();
    await assert.rejects(searchWeb('uncached synthetic failure'), /synthetic primary error/);
    assert.ok(Date.now() - errorStart < 3_000);
    failed = false;
    await searchWeb('uncached synthetic failure');
    assert.equal(toolCalls, 4, 'errors were not cached');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(closed, 4, 'SDK close aborts every held-open POST body');
    toolError = true;
    await assert.rejects(parallelSearch('tool failure'), /synthetic tool failure/);
    httpError = true;
    await assert.rejects(parallelSearch('rate limit'), /synthetic rate limit/);
    for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE', 'GET']) {
      assert.ok(seen.includes(method), method);
    }
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await settings.update({ search: original });
  }
});
