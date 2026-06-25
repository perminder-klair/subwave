// TDD tests for SearXNG web-search integration.
// All tests will FAIL until the implementation is built — that is expected.
// Run: npx tsx test/searxng/searxng-web-search.test.ts
//
// Covers:
//   - parseSearxngResponse (pure parser, no network)
//   - searxngSearch (fetch wrapper with mocked fetch)
//   - searchWeb dispatcher (SearXNG branch + recency)
//   - searchReady (per-provider readiness)
//   - Settings backend (SEARCH_PROVIDERS, baseUrl defaults, patch validation)

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSearxngResponse,
  searxngSearch,
  searchWeb,
  searchReady,
} from '../../controller/src/skills/web-search.js';
import * as settingsModule from '../../controller/src/settings.js';

// ─────────────────────────────────────────────────────────────────────────────
// parseSearxngResponse — pure parser, no network
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSearxngResponse', () => {

  it('returns empty SearchResponse when input is null', () => {
    assert.deepStrictEqual(parseSearxngResponse(null), { answer: '', results: [] });
  });

  it('returns empty SearchResponse when input is undefined', () => {
    assert.deepStrictEqual(parseSearxngResponse(undefined), { answer: '', results: [] });
  });

  it('returns empty SearchResponse when input is a string', () => {
    assert.deepStrictEqual(parseSearxngResponse('bad input'), { answer: '', results: [] });
  });

  it('returns empty SearchResponse when input is an empty object', () => {
    assert.deepStrictEqual(parseSearxngResponse({}), { answer: '', results: [] });
  });

  it('returns empty results when results array is empty', () => {
    assert.deepStrictEqual(parseSearxngResponse({ results: [] }), { answer: '', results: [] });
  });

  it('returns empty results when results field is not an array', () => {
    assert.deepStrictEqual(parseSearxngResponse({ results: 'nope' }), { answer: '', results: [] });
    assert.deepStrictEqual(parseSearxngResponse({ results: 42 }), { answer: '', results: [] });
    assert.deepStrictEqual(parseSearxngResponse({ results: null }), { answer: '', results: [] });
  });

  it('maps title and content correctly', () => {
    const out = parseSearxngResponse({
      results: [{ title: 'Song Title', content: 'Some snippet text' }],
    });
    assert.deepStrictEqual(out.results[0], { title: 'Song Title', content: 'Some snippet text' });
  });

  it('filters out results with empty title', () => {
    const out = parseSearxngResponse({
      results: [
        { title: '', content: 'has content' },
        { title: 'has title', content: 'has content' },
      ],
    });
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].title, 'has title');
  });

  it('filters out results with empty content', () => {
    const out = parseSearxngResponse({
      results: [
        { title: 'has title', content: '' },
        { title: 'real', content: 'real content' },
      ],
    });
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].title, 'real');
  });

  it('filters out results with missing title field', () => {
    const out = parseSearxngResponse({
      results: [
        { content: 'orphan content' },
        { title: 'real', content: 'real content' },
      ],
    });
    assert.strictEqual(out.results.length, 1);
  });

  it('filters out results with missing content field', () => {
    const out = parseSearxngResponse({
      results: [
        { title: 'orphan title' },
        { title: 'real', content: 'real content' },
      ],
    });
    assert.strictEqual(out.results.length, 1);
  });

  it('filters out results where title or content is null or non-string', () => {
    const out = parseSearxngResponse({
      results: [
        { title: null, content: 'some content' },
        { title: 123, content: 'some content' },
        { title: 'real', content: 'real content' },
      ],
    });
    assert.strictEqual(out.results.length, 1);
  });

  it('handles mixed valid and null entries in results array', () => {
    const out = parseSearxngResponse({
      results: [
        null,
        undefined,
        { title: 'Real', content: 'Content' },
        'not an object',
      ],
    });
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].title, 'Real');
  });

  it('caps results to 10 even when SearXNG returns 36', () => {
    const results = Array.from({ length: 36 }, (_, i) => ({
      title: `Title ${i}`,
      content: `Content ${i}`,
    }));
    const out = parseSearxngResponse({ results });
    assert.strictEqual(out.results.length, 10);
    assert.strictEqual(out.results[0].title, 'Title 0');
    assert.strictEqual(out.results[9].title, 'Title 9');
  });

  it('exactly 10 valid results returns all 10 (boundary)', () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      title: `T${i}`, content: `C${i}`,
    }));
    assert.strictEqual(parseSearxngResponse({ results }).results.length, 10);
  });

  it('exactly 11 valid results returns only first 10', () => {
    const results = Array.from({ length: 11 }, (_, i) => ({
      title: `T${i}`, content: `C${i}`,
    }));
    const out = parseSearxngResponse({ results });
    assert.strictEqual(out.results.length, 10);
    assert.strictEqual(out.results[9].title, 'T9');
  });

  it('truncates content to 300 characters', () => {
    const out = parseSearxngResponse({
      results: [{ title: 'T', content: 'x'.repeat(400) }],
    });
    assert.strictEqual(out.results[0].content.length, 300);
  });

  it('content of exactly 300 chars is not truncated', () => {
    const exact = 'a'.repeat(300);
    const out = parseSearxngResponse({ results: [{ title: 'T', content: exact }] });
    assert.strictEqual(out.results[0].content.length, 300);
  });

  it('content of 301 chars IS truncated to 300', () => {
    const over = 'a'.repeat(301);
    const out = parseSearxngResponse({ results: [{ title: 'T', content: over }] });
    assert.strictEqual(out.results[0].content.length, 300);
  });

  it('preserves content shorter than 300 characters', () => {
    const short = 'short content';
    const out = parseSearxngResponse({ results: [{ title: 'T', content: short }] });
    assert.strictEqual(out.results[0].content, short);
  });

  it('trims whitespace from title and content', () => {
    const out = parseSearxngResponse({
      results: [{ title: '  Padded Title  ', content: '  Padded Content  ' }],
    });
    assert.strictEqual(out.results[0].title, 'Padded Title');
    assert.strictEqual(out.results[0].content, 'Padded Content');
  });

  // answer slot — infoboxes (plan decision Q1: first infobox, else empty)

  it('sets answer from first infobox content when present', () => {
    const out = parseSearxngResponse({
      results: [],
      infoboxes: [{ content: 'Albert Einstein was a physicist.' }],
    });
    assert.strictEqual(out.answer, 'Albert Einstein was a physicist.');
  });

  it('uses only first infobox when multiple present', () => {
    const out = parseSearxngResponse({
      results: [],
      infoboxes: [
        { content: 'First infobox' },
        { content: 'Second — should be ignored' },
      ],
    });
    assert.strictEqual(out.answer, 'First infobox');
  });

  it('returns empty answer when infoboxes array is empty', () => {
    const out = parseSearxngResponse({ results: [], infoboxes: [] });
    assert.strictEqual(out.answer, '');
  });

  it('returns empty answer when infobox has no content field', () => {
    const out = parseSearxngResponse({ results: [], infoboxes: [{ title: 'no content' }] });
    assert.strictEqual(out.answer, '');
  });

  it('returns empty answer when answers and infoboxes are both absent', () => {
    const out = parseSearxngResponse({ results: [{ title: 'T', content: 'C' }] });
    assert.strictEqual(out.answer, '');
  });

  it('ignores suggestions field — only results, infoboxes matter', () => {
    const out = parseSearxngResponse({
      results: [{ title: 'T', content: 'C' }],
      suggestions: ['suggestion1', 'suggestion2'],
    });
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.answer, '');
  });

  it('answer slot has no length cap (infobox content kept in full)', () => {
    const longContent = 'z'.repeat(1000);
    const out = parseSearxngResponse({ results: [], infoboxes: [{ content: longContent }] });
    assert.strictEqual(out.answer.length, 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// searxngSearch — fetch wrapper
// ─────────────────────────────────────────────────────────────────────────────

describe('searxngSearch', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalGet: typeof settingsModule.settings.get;

  before(() => {
    originalFetch = globalThis.fetch;
    originalGet = settingsModule.settings.get;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    settingsModule.settings.get = originalGet;
  });

  function stubSettings(baseUrl: string) {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', apiKey: '', baseUrl } }) as any;
  }

  it('calls /search with format=json appended', async () => {
    stubSettings('http://192.168.0.112:8888');
    const captured: string[] = [];
    globalThis.fetch = mock.fn((url: string) => {
      captured.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searxngSearch('Sabrina Carpenter');
    assert.ok(captured[0].includes('/search?'), 'should hit /search');
    assert.ok(captured[0].includes('format=json'), 'should include format=json');
  });

  it('URL-encodes the query', async () => {
    stubSettings('http://localhost:8888');
    const captured: string[] = [];
    globalThis.fetch = mock.fn((url: string) => {
      captured.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searxngSearch('artist & news');
    // URL should not contain a raw ampersand inside the query value
    const urlObj = new URL(captured[0]);
    assert.strictEqual(urlObj.searchParams.get('q'), 'artist & news');
  });

  it('appends time_range=week when recency is week', async () => {
    stubSettings('http://localhost:8888');
    const captured: string[] = [];
    globalThis.fetch = mock.fn((url: string) => {
      captured.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searxngSearch('artist news', { recency: 'week' });
    const urlObj = new URL(captured[0]);
    assert.strictEqual(urlObj.searchParams.get('time_range'), 'week');
  });

  it('appends time_range=day when recency is day', async () => {
    stubSettings('http://localhost:8888');
    const captured: string[] = [];
    globalThis.fetch = mock.fn((url: string) => {
      captured.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searxngSearch('artist news', { recency: 'day' });
    const urlObj = new URL(captured[0]);
    assert.strictEqual(urlObj.searchParams.get('time_range'), 'day');
  });

  it('appends time_range=month when recency is month', async () => {
    stubSettings('http://localhost:8888');
    const captured: string[] = [];
    globalThis.fetch = mock.fn((url: string) => {
      captured.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searxngSearch('artist news', { recency: 'month' });
    const urlObj = new URL(captured[0]);
    assert.strictEqual(urlObj.searchParams.get('time_range'), 'month');
  });

  it('does NOT append time_range when no recency provided', async () => {
    stubSettings('http://localhost:8888');
    const captured: string[] = [];
    globalThis.fetch = mock.fn((url: string) => {
      captured.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searxngSearch('artist news');
    const urlObj = new URL(captured[0]);
    assert.strictEqual(urlObj.searchParams.get('time_range'), null);
  });

  it('returns parsed SearchResponse shape from real JSON', async () => {
    stubSettings('http://localhost:8888');
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          results: [{ title: 'Song Name', content: 'Snippet text' }],
          answers: [],
          infoboxes: [],
        }),
      } as Response)
    );
    const out = await searxngSearch('test');
    assert.strictEqual(typeof out.answer, 'string');
    assert.ok(Array.isArray(out.results));
    assert.strictEqual(out.results[0].title, 'Song Name');
  });

  it('sends User-Agent header containing SUB-WAVE', async () => {
    stubSettings('http://localhost:8888');
    let capturedInit: any;
    globalThis.fetch = mock.fn((_url: string, init: any) => {
      capturedInit = init;
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searxngSearch('test');
    assert.ok(
      capturedInit?.headers?.['User-Agent']?.includes('SUB-WAVE'),
      'User-Agent must include SUB-WAVE'
    );
  });

  it('throws "SearXNG HTTP 403" on 403', async () => {
    stubSettings('http://localhost:8888');
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({ ok: false, status: 403, json: async () => ({}) } as Response)
    );
    await assert.rejects(
      () => searxngSearch('test'),
      (err: Error) => { assert.ok(err.message.includes('403')); return true; }
    );
  });

  it('throws "SearXNG HTTP 500" on 500', async () => {
    stubSettings('http://localhost:8888');
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
    );
    await assert.rejects(
      () => searxngSearch('test'),
      (err: Error) => { assert.ok(err.message.includes('500')); return true; }
    );
  });

  it('propagates network error from fetch', async () => {
    stubSettings('http://localhost:8888');
    globalThis.fetch = mock.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    await assert.rejects(
      () => searxngSearch('test'),
      (err: Error) => err.message === 'ECONNREFUSED'
    );
  });

  it('propagates JSON parse failure', async () => {
    stubSettings('http://localhost:8888');
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token'); },
      } as Response)
    );
    await assert.rejects(() => searxngSearch('test'), SyntaxError);
  });

  it('throws when baseUrl is empty string (not configured)', async () => {
    stubSettings('');
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response)
    );
    await assert.rejects(
      () => searxngSearch('test'),
      (err: Error) =>
        err.message.toLowerCase().includes('baseurl') ||
        err.message.toLowerCase().includes('configured')
    );
  });

  it('throws when baseUrl is only whitespace', async () => {
    stubSettings('   ');
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response)
    );
    await assert.rejects(() => searxngSearch('test'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// searchWeb dispatcher — SearXNG branch + recency cache key
// ─────────────────────────────────────────────────────────────────────────────

describe('searchWeb with SearXNG provider', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalGet: typeof settingsModule.settings.get;

  before(() => {
    originalFetch = globalThis.fetch;
    originalGet = settingsModule.settings.get;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    settingsModule.settings.get = originalGet;
  });

  it('dispatches to SearXNG when provider is searxng', async () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', baseUrl: 'http://localhost:8888', apiKey: '' } }) as any;
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ results: [{ title: 'T', content: 'C' }] }),
      } as Response)
    );
    const out = await searchWeb(`unique-dispatch-test-${Date.now()}`);
    const calls = (globalThis.fetch as any).mock.calls;
    assert.ok(calls.length >= 1);
    assert.ok(calls[0][0].includes('localhost:8888'));
    assert.deepStrictEqual(out.results[0], { title: 'T', content: 'C' });
  });

  it('passes recency=week to SearXNG as time_range', async () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', baseUrl: 'http://localhost:8888', apiKey: '' } }) as any;
    const captured: string[] = [];
    globalThis.fetch = mock.fn((url: string) => {
      captured.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searchWeb(`recency-week-test-${Date.now()}`, { recency: 'week' });
    assert.ok(captured[0].includes('time_range=week'));
  });

  it('does NOT pass time_range when no recency (picker-tools callsite pattern)', async () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', baseUrl: 'http://localhost:8888', apiKey: '' } }) as any;
    const captured: string[] = [];
    globalThis.fetch = mock.fn((url: string) => {
      captured.push(url);
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });
    await searchWeb(`no-recency-test-${Date.now()}`);
    assert.ok(!captured[0].includes('time_range'));
  });

  it('same query + different recency are cached separately (no cache collision)', async () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', baseUrl: 'http://localhost:8888', apiKey: '' } }) as any;

    let fetchCount = 0;
    globalThis.fetch = mock.fn(() => {
      fetchCount++;
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });

    const q = `cache-collision-test-${Date.now()}`;
    await searchWeb(q);
    await searchWeb(q, { recency: 'week' });

    // Different recency = different cache key = 2 fetch calls
    assert.ok(fetchCount >= 2, `expected >=2 fetches for different recency, got ${fetchCount}`);
  });

  it('same query + same recency hits memo cache (only 1 fetch)', async () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', baseUrl: 'http://localhost:8888', apiKey: '' } }) as any;

    let fetchCount = 0;
    globalThis.fetch = mock.fn(() => {
      fetchCount++;
      return Promise.resolve({ ok: true, json: async () => ({ results: [] }) } as Response);
    });

    const q = `memo-cache-test-${Date.now()}`;
    await searchWeb(q, { recency: 'week' });
    await searchWeb(q, { recency: 'week' });

    assert.strictEqual(fetchCount, 1, 'second call with same key should hit cache');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// searchReady — per-provider readiness
// ─────────────────────────────────────────────────────────────────────────────

describe('searchReady', () => {
  let originalGet: typeof settingsModule.settings.get;

  before(() => { originalGet = settingsModule.settings.get; });
  after(() => { settingsModule.settings.get = originalGet; });

  it('returns true for duckduckgo regardless of apiKey or baseUrl', () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'duckduckgo', apiKey: '', baseUrl: '' } }) as any;
    assert.strictEqual(searchReady(), true);
  });

  it('returns true for duckduckgo when no search settings object exists (null safety)', () => {
    settingsModule.settings.get = () => ({}) as any;
    assert.strictEqual(searchReady(), true);
  });

  it('returns true for tavily when settings.search.apiKey is set', () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'tavily', apiKey: 'tvly-abc123', baseUrl: '' } }) as any;
    assert.strictEqual(searchReady(), true);
  });

  it('returns false for tavily when apiKey is empty and no SEARCH_API_KEY env var', () => {
    const saved = process.env.SEARCH_API_KEY;
    delete process.env.SEARCH_API_KEY;
    settingsModule.settings.get = () =>
      ({ search: { provider: 'tavily', apiKey: '', baseUrl: '' } }) as any;
    assert.strictEqual(searchReady(), false);
    if (saved !== undefined) process.env.SEARCH_API_KEY = saved;
  });

  it('returns true for tavily when SEARCH_API_KEY env var is set even if settings.apiKey empty', () => {
    const saved = process.env.SEARCH_API_KEY;
    process.env.SEARCH_API_KEY = 'tvly-from-env';
    settingsModule.settings.get = () =>
      ({ search: { provider: 'tavily', apiKey: '', baseUrl: '' } }) as any;
    assert.strictEqual(searchReady(), true);
    if (saved !== undefined) process.env.SEARCH_API_KEY = saved;
    else delete process.env.SEARCH_API_KEY;
  });

  it('returns true for searxng when baseUrl is a non-empty string', () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', apiKey: '', baseUrl: 'http://192.168.0.112:8888' } }) as any;
    assert.strictEqual(searchReady(), true);
  });

  it('returns false for searxng when baseUrl is empty string', () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', apiKey: '', baseUrl: '' } }) as any;
    assert.strictEqual(searchReady(), false);
  });

  it('returns false for searxng when baseUrl is only whitespace', () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'searxng', apiKey: '', baseUrl: '   ' } }) as any;
    assert.strictEqual(searchReady(), false);
  });

  it('returns false for unknown provider', () => {
    settingsModule.settings.get = () =>
      ({ search: { provider: 'unknown-provider' } }) as any;
    assert.strictEqual(searchReady(), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings — SEARCH_PROVIDERS and baseUrl defaults
// ─────────────────────────────────────────────────────────────────────────────

describe('Settings integration for SearXNG', () => {

  it("SEARCH_PROVIDERS array includes 'searxng'", () => {
    const providers: readonly string[] = (settingsModule as any).SEARCH_PROVIDERS;
    assert.ok(providers.includes('searxng'), "SEARCH_PROVIDERS must include 'searxng'");
  });

  it('SEARCH_PROVIDERS still includes duckduckgo and tavily', () => {
    const providers: readonly string[] = (settingsModule as any).SEARCH_PROVIDERS;
    assert.ok(providers.includes('duckduckgo'));
    assert.ok(providers.includes('tavily'));
  });

  it('default search settings include baseUrl as empty string', () => {
    const DEFAULTS = (settingsModule as any).DEFAULTS;
    assert.ok(DEFAULTS?.search, 'DEFAULTS.search must exist');
    assert.ok('baseUrl' in DEFAULTS.search, 'DEFAULTS.search must have baseUrl field');
    assert.strictEqual(DEFAULTS.search.baseUrl, '');
  });

  it('default search provider remains duckduckgo', () => {
    const DEFAULTS = (settingsModule as any).DEFAULTS;
    assert.strictEqual(DEFAULTS?.search?.provider, 'duckduckgo');
  });

  it('patch validation accepts valid http baseUrl', async () => {
    const patch = { search: { provider: 'searxng', baseUrl: 'http://192.168.0.112:8888' } };
    await settingsModule.settings.patch(patch);
    const current = settingsModule.settings.get();
    assert.strictEqual((current as any).search?.baseUrl, 'http://192.168.0.112:8888');
  });

  it('patch validation accepts valid https baseUrl', async () => {
    const patch = { search: { baseUrl: 'https://searxng.example.com' } };
    await settingsModule.settings.patch(patch);
    const current = settingsModule.settings.get();
    assert.strictEqual((current as any).search?.baseUrl, 'https://searxng.example.com');
  });

  it('patch validation rejects baseUrl that does not start with http:// or https://', async () => {
    const patch = { search: { baseUrl: 'ftp://bad-protocol.com' } };
    await assert.rejects(
      () => settingsModule.settings.patch(patch),
      (err: Error) =>
        err.message.toLowerCase().includes('baseurl') ||
        err.message.toLowerCase().includes('http')
    );
  });

  it('patch validation rejects baseUrl longer than 500 chars', async () => {
    const longUrl = 'http://' + 'a'.repeat(500) + '.com';
    const patch = { search: { baseUrl: longUrl } };
    await assert.rejects(
      () => settingsModule.settings.patch(patch),
      (err: Error) =>
        err.message.toLowerCase().includes('baseurl') ||
        err.message.toLowerCase().includes('long') ||
        err.message.toLowerCase().includes('invalid')
    );
  });

  it('patch validation accepts empty baseUrl (clearing the field)', async () => {
    const patch = { search: { baseUrl: '' } };
    await settingsModule.settings.patch(patch);
    const current = settingsModule.settings.get();
    assert.strictEqual((current as any).search?.baseUrl, '');
  });
});
