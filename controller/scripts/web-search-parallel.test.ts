// Synthetic MCP responses; the live search capture is kept outside the patch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import * as settings from '../src/settings.js';
import { setCache } from '../src/settings/store.js';
import { searchReady, searchWeb } from '../src/skills/web-search.js';
import { parallelSearch, parallelSnippet, parseParallelResponse } from '../src/skills/parallel-search.js';

const UA = 'SUB-WAVE radio controller (https://github.com/perminder-klair/subwave)';
const passage = 'A passage with \u0085 and \u2028 and \u2029 intact.';
// What every provider's cleanup leaves of it: whitespace runs (U+2028 and
// U+2029 among them) collapse to one space; U+0085 is not JS whitespace.
const cleanPassage = 'A passage with \u0085 and and intact.';
const data = { results: [{ title: 'Music source', url: 'https://example.org/music', excerpts: [passage] }] };

test('parser preserves passages, limits results and tolerates malformed data', () => {
  // The shared SearchResult shape: { title, content } and nothing else, the
  // same as every other provider (the source URL is not part of the contract).
  assert.deepEqual(parseParallelResponse(data).results, [
    { title: 'Music source', content: cleanPassage },
  ]);
  assert.deepEqual(parseParallelResponse(null), { answer: '', results: [] });
  assert.deepEqual(parseParallelResponse({ results: [null, {}, 4] }).results, []);
  assert.equal(parseParallelResponse({ results: Array(10).fill(data.results[0]) }).results.length, 5);
  assert.equal(parseParallelResponse({ results: [{ title: 'A', excerpts: ['x'.repeat(900)] }] }).results[0].content.length, 300);
});

// The page chrome is the head of a real Parallel excerpt captured in review
// (a music-review page); the article sentence after it is made up.
const ARTICLE = 'There are few bands that live to become as iconic as this one, and the reissue proves it.';
const REVIEW_PAGE = '15/11/2026\nFor the latest music reviews and interviews\nSearch for:\n* Home\n* Music\n'
  + '* Album Review: Radiohead \u2013 OKNOTOK\n\nAlbum Review: Radiohead \u2013 OKNOTOK\n\nRachael Scarsbrook\n'
  + `Photo: Tom Sheehan/Nasty Little Man\n${ARTICLE}`;

test('a page-chrome excerpt yields article text: no newlines, bullets, menus or markdown', () => {
  const content = parseParallelResponse({ results: [{ title: 'Album Review', excerpts: [REVIEW_PAGE] }] }).results[0].content;
  assert.equal(content, ARTICLE);
  assert.doesNotMatch(content, /\n|^\s*[*+-]\s|Search for/);

  // A news page: a numbered link menu, a link-only breadcrumb, a markdown
  // heading, a linked byline and emphasis.
  const news = '6. [Interviews](nme.com/music-interviews)\n7. [Radar](nme.com/radar)\n\n'
    + '[News](nme.com/news) [Music News](nme.com/news/music)\n\n'
    + '# The band have \u201cnot even talked about another record\u201d\n\n'
    + 'The guitarist told _the magazine_ the last one was **hard** to make, said [the band](x.com/b).';
  assert.equal(parallelSnippet([news]),
    'The band have \u201cnot even talked about another record\u201d The guitarist told the magazine the last one was hard to make, said the band.');

  // An encyclopaedia infobox, a breadcrumb, a share row and the "..." Parallel
  // puts between excerpts: none of them survive, and the prose in each excerpt does.
  const infobox = '* Wikidata item\nAppearance\n* Start date | May 6, 2019\n* No. of shows | * 18 in North America\n'
    + 'The tour was the eighth concert tour by the singer.';
  const crumbs = 'You are here: Home > Music > News\nTwitter Facebook LinkedIn\n...\nShe spoke to us about the new record.';
  assert.equal(parallelSnippet([infobox, crumbs]),
    'The tour was the eighth concert tour by the singer. She spoke to us about the new record.');
});

test('a clean excerpt comes through unchanged apart from whitespace, and all-chrome is not lost', () => {
  const prose = 'The band announced a  run of dates\nacross Europe next spring.\r\nTickets go on sale Friday.';
  assert.equal(parallelSnippet([prose]), prose.replace(/\s+/g, ' '));
  assert.equal(parallelSnippet([prose]), parallelSnippet([prose.replace(/\s+/g, ' ')]));
  // Every excerpt is chrome: the non-navigation lines stand rather than an empty result.
  assert.equal(parallelSnippet(['* Home\n* Music\nTour dates\nSearch for:']), 'Tour dates');
  // Markup and entities get the same cleanup as every other provider.
  assert.equal(parallelSnippet(['Rock &amp; roll <b>never</b> dies.']), 'Rock & roll never dies.');
  assert.equal(parseParallelResponse({ results: [{ title: '\n   Exclusive  Interview\n ', excerpts: [prose] }] }).results[0].title,
    'Exclusive Interview');
});

test('a result that is only a list, or CJK prose, keeps its text', () => {
  // Tour dates, a discography and a tracklist: lists end to end, no prose line.
  assert.equal(parallelSnippet(['* May 3 \u2014 London, O2 Academy\n* May 5 \u2014 Paris, Olympia']),
    'May 3 \u2014 London, O2 Academy May 5 \u2014 Paris, Olympia');
  assert.equal(parallelSnippet(['* Pablo Honey (1993)\n* The Bends (1995)']), 'Pablo Honey (1993) The Bends (1995)');
  assert.equal(parallelSnippet(['1. Airbag\n2. Paranoid Android\n3. Let Down']), 'Airbag Paranoid Android Let Down');
  // Dates under a prose line are data, not a menu.
  assert.equal(parallelSnippet(['Here are the dates.\n* May 3 London\n* May 5 Paris']), 'Here are the dates. May 3 London May 5 Paris');
  // CJK has no spaces: a long list item is a sentence, and 。 ends one, so a
  // Japanese excerpt is not dropped beside an English one.
  const ja = '\u5b87\u591a\u7530\u30d2\u30ab\u30eb\u304c\u65b0\u3057\u3044\u30a2\u30eb\u30d0\u30e0\u3092\u6765\u6708\u767a\u58f2\u3059\u308b\u3053\u3068\u3092\u767a\u8868\u3057\u307e\u3057\u305f';
  assert.equal(parallelSnippet([`* ${ja}`]), ja);
  assert.equal(parallelSnippet(['* Home\n* Music\nShe released a new album this year.', `${ja}\u3002`]),
    `She released a new album this year. ${ja}\u3002`);
});

test('the cleanup stays linear on hostile page text', () => {
  // Each of these took 2 to 12 seconds of blocked event loop with quadratic regexes
  // or line joining; linear, each is a few milliseconds.
  const hostile = ['['.repeat(100_000), '!['.repeat(50_000), '[a]('.repeat(25_000), '[('.repeat(50_000),
    '<'.repeat(100_000), 'a\n'.repeat(200_000), `A\n${'b\n'.repeat(200_000)}`];
  for (const text of hostile) {
    const start = performance.now();
    parallelSnippet([text]);
    parseParallelResponse({ results: [{ title: text, excerpts: [text] }] });
    const took = performance.now() - start;
    assert.ok(took < 1_000, `${JSON.stringify(text.slice(0, 8))}: ${Math.round(took)}ms`);
  }
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
        : { result: { isError: toolError, content: [{ type: 'text', text: toolError ? `synthetic tool failure ${'x'.repeat(5_000)}` : JSON.stringify(data) }] } };
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
    assert.equal(response.results[0].content, cleanPassage);
    assert.deepEqual(Object.keys(response.results[0]).sort(), ['content', 'title']);
    await searchWeb('Sabrina Carpenter artist tour news', { recency: 'week' });
    assert.equal(toolCalls, 1, 'dispatcher memo preserved');
    assert.match(String(bodies[0].objective), /past week/);
    assert.deepEqual(bodies[0].search_queries, ['Sabrina Carpenter artist tour news']);
    teardownFailed = true;
    assert.equal((await parallelSearch('cleanup failure')).results[0].content, cleanPassage);
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
    // The server's error text leads the message, capped: a 5,000-character reply
    // does not become a 5,000-character log line.
    await assert.rejects(parallelSearch('tool failure'), (err: Error) => {
      assert.match(err.message, /^Parallel search failed: synthetic tool failure x+…$/);
      assert.ok(err.message.length <= 'Parallel search failed: '.length + 201, String(err.message.length));
      return true;
    });
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

test('one deadline covers the whole search: a stall at any step ends it there, and the session still closes', async () => {
  const realFetch = globalThis.fetch;
  let stallAt = '';
  let held: Promise<void> = Promise.resolve();
  const deletes: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    if (req.method === 'DELETE') { deletes.push(stallAt); res.writeHead(200).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    if (!('id' in rpc)) { res.writeHead(202).end(); return; }
    if (rpc.method === stallAt) {
      // Never answer: only the client giving up ends this request.
      held = new Promise(resolve => res.on('close', () => resolve()));
      return;
    }
    let result: unknown;
    if (rpc.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } };
      res.setHeader('mcp-session-id', 'stall-session');
    } else if (rpc.method === 'tools/list') {
      result = { tools: [{ name: 'web_search', inputSchema: { type: 'object' } }] };
    } else {
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  globalThis.fetch = ((_input, init) => realFetch(`http://127.0.0.1:${port}/mcp`, init)) as typeof fetch;
  try {
    for (const step of ['initialize', 'tools/list', 'tools/call']) {
      stallAt = step;
      const start = Date.now();
      await assert.rejects(parallelSearch(`stall at ${step}`, undefined, { deadlineMs: 400 }), /timed out after 0\.4s/, step);
      const took = Date.now() - start;
      // The deadline, not a per-step 30 s, ended it (the server answers DELETE at once).
      assert.ok(took >= 350 && took < 2_000, `${step}: ${took}ms`);
      // The stalled request was torn down, not left open on the server.
      await held;
    }
    // A session that existed was closed; the stall at initialize never had one.
    assert.deepEqual(deletes, ['tools/list', 'tools/call']);
    // The same server answers a search that stalls nowhere.
    stallAt = '';
    assert.equal((await parallelSearch('no stall', undefined, { deadlineMs: 2_000 })).results[0].content, cleanPassage);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
