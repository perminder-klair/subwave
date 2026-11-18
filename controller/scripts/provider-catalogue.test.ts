// The provider catalogue (src/schemas/providers.ts) against everything that
// must agree with it. A new provider is one catalogue entry, plus a capability
// descriptor when it has a real quirk; these checks are what make a missing
// half fail here instead of on a station. A fixed-endpoint OpenAI-compatible
// gateway needs no descriptor at all: it gets the generic one, and only its
// reasoning rule is pinned below.
//
// Run: `npm test -- provider-catalogue`.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-provider-catalogue-'));
process.env.STATE_DIR = stateRoot;

const {
  LLM_PROVIDER_CATALOG, OPENAI_COMPATIBLE_GATEWAYS, PROVIDER_GROUPS,
} = await import('../src/schemas/providers.js');
const { SEARCH_PROVIDER_CATALOG, SETTINGS_SEARCH_PROVIDERS } = await import('../src/schemas/settings.js');
const settings = await import('../src/settings.js');
const { SECRET_ENV_KEYS } = await import('../src/setup/secrets.js');
const { capabilitiesFor, reasoningFor, REASONING_RULES, embeddingSharesChatCredential } =
  await import('../src/llm/internal/provider/capabilities.js');
const { languageModel } = await import('../src/llm/internal/provider/registry.js');
const { generateText } = await import('ai');
const { chatCompletion } = await import('./test-utils/llm.js');

const DEFAULT_CAPS = capabilitiesFor('no-such-provider');

test('ids are unique and every entry is well formed', () => {
  const ids = LLM_PROVIDER_CATALOG.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of LLM_PROVIDER_CATALOG) {
    assert.ok(p.label && p.longLabel && p.blurb && p.cliLabel, `${p.id}: label, longLabel, blurb and cliLabel are required`);
    assert.ok(PROVIDER_GROUPS.includes(p.group), `${p.id}: unknown group ${p.group}`);
    // A cloud provider needs a key, and the CLI derives its hint from envVar.
    assert.equal(p.kind === 'cloud', Boolean(p.envVar), `${p.id}: cloud iff envVar`);
    assert.equal(Boolean(p.envVar), Boolean(p.keyPlaceholder), `${p.id}: a key field needs a placeholder`);
    if (!p.envVar) assert.ok(p.cliHint, `${p.id}: a keyless provider needs a CLI hint`);
    if (p.id !== 'ollama') assert.ok(p.exampleModel, `${p.id}: the CLI shows an example model id`);
  }
});

test('the controller lists are the catalogue, in its order', () => {
  assert.deepEqual(settings.LLM_PROVIDERS, LLM_PROVIDER_CATALOG.map(p => p.id));
  assert.deepEqual(settings.EMBEDDING_PROVIDERS, LLM_PROVIDER_CATALOG.filter(p => p.embedding).map(p => p.id));
  assert.deepEqual([...settings.SEARCH_PROVIDERS], SEARCH_PROVIDER_CATALOG.map(p => p.id));
  assert.deepEqual([...SETTINGS_SEARCH_PROVIDERS], SEARCH_PROVIDER_CATALOG.map(p => p.id));
});

test('every provider key may be saved, and only through SECRET_ENV_KEYS', () => {
  for (const p of LLM_PROVIDER_CATALOG) {
    if (p.envVar) assert.ok(SECRET_ENV_KEYS.includes(p.envVar), `${p.id}: ${p.envVar} is not in SECRET_ENV_KEYS`);
  }
  if (SEARCH_PROVIDER_CATALOG.some(p => p.key !== 'none')) assert.ok(SECRET_ENV_KEYS.includes('SEARCH_API_KEY'));
});

test('every provider has a capability descriptor, generated for a fixed-endpoint gateway', () => {
  for (const p of LLM_PROVIDER_CATALOG) {
    assert.notEqual(capabilitiesFor(p.id), DEFAULT_CAPS, `${p.id} has no capability descriptor`);
  }
});

// languageModel()'s switch falls through to Ollama, so a provider with no case
// there would quietly build an Ollama client on localhost:11434.
test('every provider but Ollama gets its own client from the registry', () => {
  for (const p of LLM_PROVIDER_CATALOG) {
    const { provider } = languageModel({ provider: p.id, model: 'x', baseUrl: 'http://127.0.0.1:1/v1' });
    assert.equal(provider === 'ollama', p.id === 'ollama', `${p.id}: the registry built a "${provider}" model`);
  }
});

test('a fixed-endpoint gateway pins its key, shares it with embeddings, and has a reasoning rule', () => {
  assert.ok(OPENAI_COMPATIBLE_GATEWAYS.length > 0);
  for (const gw of OPENAI_COMPATIBLE_GATEWAYS) {
    const c = capabilitiesFor(gw.id);
    assert.equal(gw.group, 'gateway');
    assert.match(gw.openaiCompatible.baseUrl, /^https:\/\/[^/]+.*[^/]$/, `${gw.id}: an https base URL with no trailing slash`);
    // A builder that reads its own env var captures the key at construction,
    // so the cache must see it (registry.pinnedApiKey); #1427's bug.
    assert.equal(c.apiKeyEnv, gw.envVar);
    assert.equal(c.reasoningLevel, REASONING_RULES[gw.openaiCompatible.reasoning]);
    assert.equal(embeddingSharesChatCredential({ provider: gw.id }, { provider: gw.id }), Boolean(gw.embedding));
  }
});

// Each gateway's rule, pinned on the wire values it sends. A new gateway adds
// its row here, which is where a copied lambda would have been caught (#2097).
const GATEWAY_REASONING: Record<string, Record<string, string | undefined>> = {
  requesty: {
    'openai/gpt-5.4-mini|off': 'minimal', 'openai/gpt-5.4-mini|on': undefined, 'openai/gpt-5.4-mini|forced': 'minimal',
    'anthropic/claude-sonnet-5.5|off': 'minimal', 'gpt-4o-mini|off': 'minimal',
  },
  // Bare OpenAI ids, so OpenAI's own rule: a dotted GPT-5 turns thinking off
  // with 'none' (it rejects 'minimal'), an undotted one with 'minimal', and a
  // GPT-4-class or non-OpenAI id gets no field at all.
  cheaperinference: {
    'gpt-5.4-mini|off': 'none', 'gpt-5.4-mini|on': 'medium', 'gpt-5.4-mini|forced': 'medium',
    'gpt-5-mini|off': 'minimal', 'gpt-4o-mini|off': undefined,
    'claude-sonnet-4-5|off': undefined, 'claude-sonnet-5-5|off': undefined,
  },
};

test('each gateway reasoning rule is pinned', () => {
  assert.deepEqual(Object.keys(GATEWAY_REASONING).sort(), OPENAI_COMPATIBLE_GATEWAYS.map(g => g.id).sort());
  for (const [id, cases] of Object.entries(GATEWAY_REASONING)) {
    for (const [key, want] of Object.entries(cases)) {
      const [model, mode] = key.split('|');
      const got = reasoningFor({ provider: id, model, reasoning: mode === 'on' || mode === 'forced' },
        { forceNoThink: mode === 'forced' });
      assert.equal(got, want, `${id} ${key}`);
    }
  }
});

// The same rows on the wire: what the strategies pass as `reasoning` (text.ts,
// object.ts) is what reaches the gateway as reasoning_effort, and an undefined
// level sends no field at all.
test('each gateway reasoning rule reaches the wire as reasoning_effort', async (t) => {
  for (const [id, cases] of Object.entries(GATEWAY_REASONING)) {
    const gw = OPENAI_COMPATIBLE_GATEWAYS.find(g => g.id === id)!;
    for (const [key, want] of Object.entries(cases)) {
      const [model, mode] = key.split('|');
      const cfg = { provider: id, model, apiKey: 'k', reasoning: mode === 'on' || mode === 'forced' };
      const sent: { url: string; body: Record<string, unknown> }[] = [];
      t.mock.method(globalThis, 'fetch', (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(chatCompletion({ model,
          message: { role: 'assistant', content: 'ok' },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })),
        { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch);
      await generateText({
        model: languageModel(cfg), prompt: 'hi', maxRetries: 0,
        reasoning: reasoningFor(cfg, { forceNoThink: mode === 'forced' }),
      });
      t.mock.restoreAll();
      assert.equal(sent.length, 1, `${id} ${key}`);
      assert.equal(sent[0].url, `${gw.openaiCompatible.baseUrl}/chat/completions`, `${id} ${key}`);
      if (want === undefined) assert.equal('reasoning_effort' in sent[0].body, false, `${id} ${key} sent ${sent[0].body.reasoning_effort}`);
      else assert.equal(sent[0].body.reasoning_effort, want, `${id} ${key}`);
    }
  }
});

test('every search provider says how it takes a key', () => {
  for (const p of SEARCH_PROVIDER_CATALOG) {
    assert.ok(p.label && p.hint, `${p.id}: label and hint are required`);
    if (p.key !== 'none') assert.ok(p.keyName && p.keyPlaceholder && p.keyUrl, `${p.id}: a keyed provider names its key`);
  }
});
