// settings.llm.headers / llm.fallback.headers — extra request headers for the
// openai-compatible transport (issue #1618).
//
// OpenCode Zen Go began requiring an `x-opencode-session` header, and with no
// passthrough every model call 400'd while the station kept playing: no agent
// picks, no DJ links, no station IDs. Nothing here names OpenCode — the map is
// opaque, and any gateway needing an auth or routing header is the same case.
//
// Four things are pinned, and each is a different way the feature can be dead:
//   - a COLD-LOAD round trip, because settings.load()'s llm block composes
//     explicitly rather than spreading DEFAULTS — a field missing there saves,
//     works for that process, and vanishes on the next restart (#1327);
//   - the CACHE SIGNATURE, because headers are captured when the client is
//     built, so a signature that ignores them keeps handing back the instance
//     carrying the old set — and hands the FALLBACK leg the primary's client;
//   - the WIRE, against a capturing fetch — the only proof the header actually
//     leaves the process;
//   - byte-identical behaviour with no headers configured, which is what an
//     upgraded station gets.
//
// No credentials and no external host.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/llm-repeat-penalty.test.ts).
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-llm-headers-'));
process.env.STATE_DIR = stateRoot;

const { setCache, getRedacted } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { customHeaders, languageModel } = await import('../src/llm/internal/provider/registry.js');
const { generateText } = await import('ai');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

const BASE_LLM = {
  provider: 'openai-compatible',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://gateway.example/v1',
};

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm: { ...BASE_LLM, ...llm } }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

// One chat/completions call through a stubbed global fetch (debugFetch, the
// inner transport for every provider, delegates to it), answering with the
// smallest valid completion. Returns the outbound headers, lower-cased.
async function headersOnTheWire(cfg: Record<string, unknown>): Promise<Record<string, string>> {
  const real = globalThis.fetch;
  const seen: Record<string, string> = {};
  globalThis.fetch = (async (_url: unknown, init: { headers?: unknown }) => {
    const raw = init?.headers;
    const entries = raw instanceof Headers
      ? [...raw.entries()]
      : Object.entries((raw ?? {}) as Record<string, string>);
    for (const [k, v] of entries) if (v != null) seen[String(k).toLowerCase()] = String(v);
    return new Response(
      JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: String(cfg.model),
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    await generateText({ model: languageModel(cfg), prompt: 'hi', maxRetries: 0 });
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

test('a configured header survives a controller restart', async () => {
  const llm = await coldLoad({ headers: { 'x-gateway-session': 'subwave-1' } });
  assert.deepEqual(llm.headers, { 'x-gateway-session': 'subwave-1' });
  // Only useful insofar as it reaches the client builder.
  assert.deepEqual(customHeaders(llm), { 'x-gateway-session': 'subwave-1' });
});

test('the fallback leg carries its own headers across a restart', async () => {
  const llm = await coldLoad({
    headers: { 'x-gateway-session': 'primary' },
    fallback: {
      enabled: true,
      provider: 'openai-compatible',
      model: 'gemma',
      baseUrl: 'https://backup.example/v1',
      headers: { 'x-gateway-session': 'backup' },
    },
  });
  assert.deepEqual(llm.headers, { 'x-gateway-session': 'primary' });
  assert.deepEqual(llm.fallback.headers, { 'x-gateway-session': 'backup' });
});

test('an untouched station has no headers and adds nothing to the request', async () => {
  // A settings.json written before the field existed: absent → {} → the client
  // is built with no `headers` option at all, so the call is what it was.
  const llm = await coldLoad({});
  assert.deepEqual(llm.headers, {});
  assert.equal(customHeaders(llm), undefined);
  assert.equal(customHeaders({ headers: {} }), undefined);

  const sent = await headersOnTheWire({ ...BASE_LLM });
  assert.ok(sent.authorization, 'the bearer header the SDK always sends is still there');
  assert.equal(sent['x-gateway-session'], undefined);
});

test('the load path repairs or drops a bad stored map, never throws', async () => {
  const llm = await coldLoad({
    headers: {
      'x-good': ' kept ',              // trimmed
      'bad header': 'v',               // space is not a token character
      'x-newline': 'a\r\nInjected: 1', // header injection, refused not repaired
      'x-empty': '   ',                // nothing to send
      'x-long': 'v'.repeat(501),       // over the value cap
      'x-number': 7,                   // not a string, but String()-able
    },
  });
  assert.deepEqual(llm.headers, { 'x-good': 'kept', 'x-number': '7' });

  // Not an object at all — a hand-edited settings.json must not wedge boot.
  assert.deepEqual((await coldLoad({ headers: 'nope' })).headers, {});
  assert.deepEqual((await coldLoad({ headers: ['a'] })).headers, {});

  // The count cap holds on the load path too.
  const many: Record<string, string> = {};
  for (let i = 0; i < 15; i++) many[`x-h${i}`] = 'v';
  assert.equal(Object.keys((await coldLoad({ headers: many })).headers).length, 10);
});

test('the save path refuses what the load path drops', async () => {
  await coldLoad({});
  const save = (headers: unknown) => settings.update({ llm: { headers } } as never);

  await assert.rejects(save('nope'), /llm\.headers must be an object map/);
  await assert.rejects(save({ 'bad header': 'v' }), /invalid header name/);
  await assert.rejects(save({ 'x-h': 'a\r\nInjected: 1' }), /printable ASCII on a single line/);
  await assert.rejects(save({ 'x-h': 'v'.repeat(501) }), /must be 0-500 chars/);
  const many: Record<string, string> = {};
  for (let i = 0; i < 11; i++) many[`x-h${i}`] = 'v';
  await assert.rejects(save(many), /at most 10 entries/);

  // The fallback leg states its own label, so an error names the leg that failed.
  await assert.rejects(
    settings.update({ llm: { fallback: { headers: { 'bad header': 'v' } } } } as never),
    /llm\.fallback\.headers/,
  );
});

test('the editor sends the whole map: an omitted row is a deleted header', async () => {
  await coldLoad({ headers: { 'x-a': '1', 'x-b': '2' } });
  // Whole-map replace, like tts.corrections — the admin editor is a row list
  // and always posts the full edited set, so a merge would make Remove a no-op.
  await settings.update({ llm: { headers: { 'x-a': '1' } } } as never);
  assert.deepEqual(settings.get().llm.headers, { 'x-a': '1' });

  // An emptied value drops the header the same way an emptied base URL does.
  await settings.update({ llm: { headers: { 'x-a': '' } } } as never);
  assert.deepEqual(settings.get().llm.headers, {});
});

test('values are redacted on the way out and survive the round trip back', async () => {
  await coldLoad({
    headers: { 'x-gateway-session': 'a-real-token' },
    fallback: {
      enabled: true, provider: 'openai-compatible', model: 'gemma',
      baseUrl: 'https://backup.example/v1', headers: { 'x-backup': 'another-token' },
    },
  });

  const redacted = getRedacted();
  // Names stay visible — the operator has to see which headers are being sent —
  // while every value is masked to the same sentinel the API keys use.
  assert.deepEqual(redacted.llm.headers, { 'x-gateway-session': 'set' });
  assert.deepEqual(redacted.llm.fallback.headers, { 'x-backup': 'set' });

  // Saving the form the admin UI hydrated from that response must not blank the
  // stored values: 'set' resolves against what is already on file.
  await settings.update({
    llm: { headers: redacted.llm.headers, fallback: { headers: redacted.llm.fallback.headers } },
  } as never);
  assert.equal(settings.get().llm.headers['x-gateway-session'], 'a-real-token');
  assert.equal(settings.get().llm.fallback.headers['x-backup'], 'another-token');

  // And a retyped value still wins over the stored one.
  await settings.update({ llm: { headers: { 'x-gateway-session': 'rotated' } } } as never);
  assert.equal(settings.get().llm.headers['x-gateway-session'], 'rotated');

  // 'set' for a header that is NOT on file is nothing to keep, not a literal.
  await settings.update({ llm: { headers: { 'x-never-saved': 'set' } } } as never);
  assert.deepEqual(settings.get().llm.headers, {});
});

test('changing the headers rebuilds the model — they are bound at construction', () => {
  const withA = languageModel({ ...BASE_LLM, headers: { 'x-s': 'a' } });
  assert.equal(languageModel({ ...BASE_LLM, headers: { 'x-s': 'a' } }), withA, 'unchanged → cached');
  // Key order is not a change; the value is.
  assert.equal(
    languageModel({ ...BASE_LLM, headers: { 'x-s': 'a', 'x-t': 'b' } }),
    languageModel({ ...BASE_LLM, headers: { 'x-t': 'b', 'x-s': 'a' } }),
    'reordered → same client',
  );
  assert.notEqual(languageModel({ ...BASE_LLM, headers: { 'x-s': 'b' } }), withA, 'changed → rebuilt');
  assert.notEqual(languageModel({ ...BASE_LLM }), withA, 'removed → rebuilt');

  // A station with no headers keys exactly as an empty map does, so declaring
  // the field cannot split one station's cache in two.
  assert.equal(languageModel({ ...BASE_LLM }), languageModel({ ...BASE_LLM, headers: {} }));

  // Leg switching: two legs differing ONLY in their headers must not share a
  // client, or the fallback talks to its gateway with the primary's session.
  const primary = { ...BASE_LLM, headers: { 'x-s': 'primary' } };
  const fallback = { ...BASE_LLM, headers: { 'x-s': 'backup' } };
  assert.notEqual(languageModel(primary), languageModel(fallback));
});

test('the configured header is what lands on the wire', async () => {
  const sent = await headersOnTheWire({
    ...BASE_LLM,
    headers: { 'x-gateway-session': 'subwave-1', 'x-tenant': 'radio' },
  });
  assert.equal(sent['x-gateway-session'], 'subwave-1');
  assert.equal(sent['x-tenant'], 'radio');
  assert.ok(sent.authorization, 'and the bearer token is still sent alongside');

  // locca is the same transport and the same builder, so it carries them too.
  const locca = await headersOnTheWire({
    provider: 'locca', model: 'gemma', baseUrl: 'https://locca.example/v1',
    headers: { 'x-gateway-session': 'via-locca' },
  });
  assert.equal(locca['x-gateway-session'], 'via-locca');
});
