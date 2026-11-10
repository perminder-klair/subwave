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
import { chatCompletionResponse } from './test-utils/llm.js';
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
  // Ids from OrcaRouter's public GET /models. It refuses 'minimal', so a family
  // that cannot go to 'none' floors at 'low'.
  orcarouter: {
    'anthropic/claude-sonnet-5.5|off': 'low', 'anthropic/claude-opus-5.5|forced': 'low',
    'anthropic/claude-fable-5.2|off': 'low', 'anthropic/claude-sonnet-5.5|on': undefined,
    'anthropic/claude-sonnet-4.6|off': 'none', 'anthropic/claude-opus-5|off': 'none',
    'openai/gpt-5|off': 'low', 'openai/gpt-5-mini|forced': 'low', 'openai/gpt-5-nano-2025-08-07|off': 'low',
    'openai/gpt-5.1-codex|off': 'low', 'openai/gpt-6-sol|off': 'low',
    'openai/gpt-5.4-mini|off': 'none', 'openai/gpt-5.4-mini|forced': 'none', 'openai/gpt-5.4-mini|on': undefined,
    'gpt-5.6-luna|off': 'none',
    'openai/gpt-4o-mini|off': undefined, 'openai/gpt-4.1|forced': undefined, 'openai/gpt-3.5-turbo|off': undefined,
    'openai/gpt-5-chat-latest|off': undefined, 'openai/gpt-5-search-api|off': undefined,
    'openai/gpt-5-pro|off': undefined, 'openai/gpt-5.2-pro|forced': undefined,
    'google/gemma-4-31b-it|off': undefined, 'obsidian/gemma-4-26B-A4B|off': undefined,
    'google/gemini-2.5-flash|off': 'none', 'deepseek/deepseek-chat|forced': 'none', 'qwen/qwen3.6-plus|off': 'none',
    'orcarouter/free|off': undefined, 'orcarouter/fusion|forced': undefined, 'orcarouter/auto|off': undefined,
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

// The pinned level has to survive the SDK: a level it filters for these ids
// would never reach the gateway, and an omitted one must send no field at all.
test('each gateway reasoning level reaches the wire as reasoning_effort', async (t) => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return chatCompletionResponse('ok');
  }) as typeof fetch);
  for (const [id, cases] of Object.entries(GATEWAY_REASONING)) {
    for (const [key, want] of Object.entries(cases)) {
      const [model, mode] = key.split('|');
      const cfg = { provider: id, model, apiKey: 'test-key', reasoning: mode !== 'off' };
      const forceNoThink = mode === 'forced';
      body = {};
      await generateText({
        model: languageModel(cfg, { forceNoThink }), prompt: 'hi', maxRetries: 0,
        reasoning: reasoningFor(cfg, { forceNoThink }),
      });
      assert.equal(body.model, model, `${id} ${key}`);
      assert.equal(body.reasoning_effort, want, `${id} ${key}`);
      assert.equal('reasoning_effort' in body, want !== undefined, `${id} ${key}`);
    }
  }
});

// Where the admin Test key and the CLI probe send each gateway's key. A public
// model list can be answered from a CDN cache whatever the bearer: OrcaRouter's
// /models sometimes gave a bad key the cached list as a 200, so it checks its
// billing summary instead (#1427). A new gateway adds its row here.
const KEY_CHECK_URL: Record<string, string> = {
  requesty: 'https://router.requesty.ai/v1/models',
  orcarouter: 'https://api.orcarouter.ai/v1/dashboard/billing/subscription',
};

test('each gateway key check URL is pinned, and the CLI probe sends the key there', async (t) => {
  assert.deepEqual(Object.keys(KEY_CHECK_URL).sort(), OPENAI_COMPATIBLE_GATEWAYS.map(g => g.id).sort());
  for (const gw of OPENAI_COMPATIBLE_GATEWAYS) {
    assert.equal(`${gw.openaiCompatible.baseUrl}${gw.openaiCompatible.keyCheckPath}`, KEY_CHECK_URL[gw.id], gw.id);
  }
  // The CLI is its own package with no test runner, so its probe and its copy
  // of the catalogue are loaded here. Computed specifiers keep the controller's
  // tsc from type-checking the CLI's sources under this package's config.
  const cliProbes = await import(String(new URL('../../cli/src/probes.ts', import.meta.url)));
  const cliCatalog = (await import(String(new URL('../../cli/src/providers.generated.ts', import.meta.url)))).LLM_PROVIDER_CATALOG;
  const seen: { url: string; auth: string }[] = [];
  t.mock.method(globalThis, 'fetch', (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') || '' });
    return Response.json({ object: 'billing_subscription' });
  }) as typeof fetch);
  const cliGateways = (cliCatalog as { id: string; openaiCompatible?: unknown }[]).filter(p => p.openaiCompatible);
  assert.deepEqual(cliGateways.map(g => g.id).sort(), Object.keys(KEY_CHECK_URL).sort());
  for (const gw of cliGateways) {
    seen.length = 0;
    const r = await cliProbes.probeGatewayKey({ apiKey: 'cli-key', gateway: gw.openaiCompatible });
    assert.deepEqual(r, { ok: true, detail: 'key accepted' }, gw.id);
    assert.deepEqual(seen, [{ url: KEY_CHECK_URL[gw.id], auth: 'Bearer cli-key' }], gw.id);
  }
});

test('every search provider says how it takes a key', () => {
  for (const p of SEARCH_PROVIDER_CATALOG) {
    assert.ok(p.label && p.hint, `${p.id}: label and hint are required`);
    if (p.key !== 'none') assert.ok(p.keyName && p.keyPlaceholder && p.keyUrl, `${p.id}: a keyed provider names its key`);
  }
});
