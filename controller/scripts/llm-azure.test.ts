// Azure OpenAI provider — the endpoint resolver and the settings round trip.
//
// Azure is the one cloud provider with no hosted endpoint: the resource URL is
// per-install, and it rides the EXISTING per-provider base-URL map
// (llm.providerBaseUrls.azure, issue #1082) rather than a settings field of its
// own. That reuse is the thing worth pinning — a key-bearing provider whose
// endpoint silently failed to survive a restart would look exactly like a bad
// key, so the round trip here is COLD (setCache(null) + load()), the same shape
// as llm-repeat-penalty.test.ts and for the same reason: an in-process
// assertion passes on the broken code.
//
// The other half is the two Azure API surfaces. Which one a resource serves is
// not discoverable from the URL, so azureEndpoint() decides from what the
// operator pasted — bare root → the modern /openai/v1 surface; a pasted
// ?api-version=<date> → the legacy per-deployment path. Both are asserted at
// the WIRE, because the SDK does its own URL assembly on top of ours and the
// only thing that matters is the URL that leaves the process.
//
// No credentials and no network: every call runs against a capturing fetch.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected BEFORE the first import of anything config-derived.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-azure-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { LLM_PROVIDERS, EMBEDDING_PROVIDERS } = await import('../src/settings/vocab.js');
const { SECRET_ENV_KEYS } = await import('../src/setup/secrets.js');
const { azureEndpoint, languageModel, azureChatFetch } = await import('../src/llm/internal/provider/registry.js');
const { buildEmbeddingModel, resolveEmbeddingCfg } = await import('../src/llm/internal/provider/embedding.js');
const { capabilitiesFor } = await import('../src/llm/internal/provider/capabilities.js');
const { createAzure } = await import('@ai-sdk/azure');
const { generateText, embedMany } = await import('ai');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');
const RESOURCE = 'https://oai-example.openai.azure.com';

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

test('the portal endpoint resolves to the modern v1 surface', () => {
  // What "Keys and Endpoint" hands over is the bare resource root, with and
  // without a trailing slash. Both must land on the path @ai-sdk/azure reads as
  // already-versioned, so it sends NO api-version at all.
  for (const pasted of [RESOURCE, `${RESOURCE}/`, `${RESOURCE}//`, `  ${RESOURCE}  `]) {
    assert.deepEqual(azureEndpoint({ baseUrl: pasted }), { baseURL: `${RESOURCE}/openai/v1` }, pasted);
  }
  // Already carrying part or all of the path — never doubled up.
  assert.deepEqual(azureEndpoint({ baseUrl: `${RESOURCE}/openai` }), { baseURL: `${RESOURCE}/openai/v1` });
  assert.deepEqual(azureEndpoint({ baseUrl: `${RESOURCE}/openai/v1` }), { baseURL: `${RESOURCE}/openai/v1` });
  assert.deepEqual(azureEndpoint({ baseUrl: `${RESOURCE}/openai/v1/` }), { baseURL: `${RESOURCE}/openai/v1` });
  // An explicit ?api-version=v1 names the modern surface, not the legacy one.
  assert.deepEqual(azureEndpoint({ baseUrl: `${RESOURCE}/?api-version=v1` }), { baseURL: `${RESOURCE}/openai/v1` });
});

test('a pinned dated api-version selects the legacy per-deployment surface', () => {
  // This is the shape Azure's own config blobs quote, so it is what an operator
  // pastes when their resource is pinned. Resources that serve only this path
  // 404 on /openai/v1 — and a 404 here reaches the operator as a silent DJ.
  assert.deepEqual(
    azureEndpoint({ baseUrl: `${RESOURCE}/?api-version=2024-08-01-preview` }),
    { baseURL: `${RESOURCE}/openai`, apiVersion: '2024-08-01-preview', useDeploymentBasedUrls: true },
  );
  assert.deepEqual(
    azureEndpoint({ baseUrl: `${RESOURCE}/openai?api-version=2024-08-01-preview` }),
    { baseURL: `${RESOURCE}/openai`, apiVersion: '2024-08-01-preview', useDeploymentBasedUrls: true },
  );
});

test('an unset endpoint resolves empty rather than to a guess', () => {
  // There is no hosted Azure default to fall back to, so "" must stay "" and be
  // refused at the point of use with a message naming the fix.
  for (const v of [undefined, null, '', '   ']) {
    assert.deepEqual(azureEndpoint({ baseUrl: v }), { baseURL: '' }, String(v));
  }
  assert.deepEqual(azureEndpoint({}), { baseURL: '' });
  assert.deepEqual(azureEndpoint(undefined), { baseURL: '' });
  // A query with no URL in front of it is not an endpoint either.
  assert.deepEqual(azureEndpoint({ baseUrl: '?api-version=2024-08-01-preview' }), { baseURL: '' });
});

test('a custom OpenAI-shaped gateway keeps the path it was given', () => {
  // Not every Azure deployment is reached at *.openai.azure.com — a proxy in
  // front of one is an OpenAI-shaped base already, and appending /openai/v1 to
  // it would break a working URL.
  assert.deepEqual(azureEndpoint({ baseUrl: 'https://gw.example.com/v1' }), { baseURL: 'https://gw.example.com/v1' });
});

// ---------------------------------------------------------------------------
// What actually leaves the process
// ---------------------------------------------------------------------------

function captureFetch(seen: { url?: string; headers?: Record<string, string> }) {
  return (async (url: unknown, init: { headers?: HeadersInit }) => {
    seen.url = typeof url === 'string' ? url : String(url);
    seen.headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    return new Response(
      JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

async function callWith(baseUrl: string, deployment = 'gpt-4o-mini') {
  const ep = azureEndpoint({ baseUrl });
  const seen: { url?: string; headers?: Record<string, string> } = {};
  const provider = createAzure({
    baseURL: ep.baseURL,
    apiKey: 'test-key',
    ...(ep.apiVersion ? { apiVersion: ep.apiVersion } : {}),
    ...(ep.useDeploymentBasedUrls ? { useDeploymentBasedUrls: true } : {}),
    fetch: captureFetch(seen),
  });
  await generateText({ model: provider.chat(deployment), prompt: 'hi' });
  return seen;
}

test('the modern surface calls /openai/v1/chat/completions with no api-version', async () => {
  const seen = await callWith(RESOURCE);
  assert.equal(seen.url, `${RESOURCE}/openai/v1/chat/completions`);
  // Azure authenticates with `api-key`, never a bearer Authorization header.
  assert.equal(seen.headers?.['api-key'], 'test-key');
});

test('the legacy surface calls the deployment path with the pinned api-version', async () => {
  const seen = await callWith(`${RESOURCE}/?api-version=2024-08-01-preview`, 'my-gpt4o');
  assert.equal(
    seen.url,
    `${RESOURCE}/openai/deployments/my-gpt4o/chat/completions?api-version=2024-08-01-preview`,
  );
});

test('Chat Completions is pinned — the Responses API is not on every deployment', async () => {
  const seen = await callWith(RESOURCE);
  assert.ok(seen.url?.endsWith('/chat/completions'), `got ${seen.url}`);
  assert.ok(!seen.url?.includes('/responses'), 'must not target the Responses API');
});

const tokenLimitError = {
  error: {
    message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter',
  },
};

for (const baseUrl of [RESOURCE, `${RESOURCE}/?api-version=2024-08-01-preview`]) {
  for (const deployment of ['gpt-chat-latest', 'gpt-5-chat-latest', 'radio-dj']) {
    test(`token limit adapts to ${deployment} on ${baseUrl}`, async (t) => {
      const bodies: Record<string, unknown>[] = [];
      const success = captureFetch({});
      t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.max_tokens !== undefined) {
          return Response.json(tokenLimitError, { status: 400 });
        }
        return success(url as string, init);
      });
      const model = languageModel({ provider: 'azure', model: deployment, baseUrl, apiKey: 'test-key' });
      for (const maxOutputTokens of [512, 768]) {
        const result = await generateText({ model, prompt: 'hi', maxOutputTokens, maxRetries: 0 });
        assert.equal(result.text, 'OK');
      }
      assert.equal(bodies.length, 3, 'one correction, then the next call uses the learned parameter');
      assert.equal(bodies[0].max_tokens, 512);
      assert.deepEqual(bodies[1], {
        ...Object.fromEntries(Object.entries(bodies[0]).filter(([key]) => key !== 'max_tokens')),
        max_completion_tokens: 512,
      });
      assert.equal(bodies[2].max_completion_tokens, 768);
      assert.equal(bodies[2].max_tokens, undefined);
      assert.equal(bodies[2].model, deployment, 'the deployment name must stay intact');
    });
  }
}

test('working old and recognized new deployments keep their SDK token parameters', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const success = captureFetch({});
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return success(url as string, init);
  });
  for (const deployment of ['gpt-4o-mini', 'gpt-5-mini']) {
    const model = languageModel({ provider: 'azure', model: deployment, baseUrl: RESOURCE, apiKey: 'test-key' });
    await generateText({ model, prompt: 'hi', maxOutputTokens: 512, maxRetries: 0 });
  }
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 512);
  assert.equal(bodies[0].max_completion_tokens, undefined);
  assert.equal(bodies[1].max_completion_tokens, 512);
  assert.equal(bodies[1].max_tokens, undefined);
});

test('correction preserves structured output, tools, headers, signal and explicit completion limit', async () => {
  const calls: RequestInit[] = [];
  const transport = azureChatFetch(async (_url, init) => {
    calls.push(init!);
    return calls.length === 1 ? Response.json(tokenLimitError, { status: 400 }) : new Response('OK');
  });
  const body = {
    model: 'custom-deployment', max_tokens: 512, max_completion_tokens: 1024,
    messages: [{ role: 'user', content: 'pick' }],
    response_format: { type: 'json_schema', json_schema: { name: 'pick', schema: { type: 'object' } } },
    tools: [{ type: 'function', function: { name: 'done', parameters: { type: 'object' } } }],
    tool_choice: 'required', temperature: 0.5, stream: true,
  };
  const originalBody = JSON.stringify(body);
  const init = { method: 'POST', headers: { 'api-key': 'test-key' }, signal: new AbortController().signal, body: originalBody };
  await transport(RESOURCE, init);
  assert.equal(calls.length, 2);
  assert.equal(init.body, originalBody, 'never mutate the original request');
  assert.equal(calls[1].headers, init.headers);
  assert.equal(calls[1].signal, init.signal);
  // Structured output + tools, so both requests carry the serial-tool-calls
  // clamp — the parameter defaults to TRUE on Azure, so omitting it is not the
  // same as disabling it and the schema would go unenforced.
  assert.equal(JSON.parse(String(calls[0].body)).parallel_tool_calls, false);
  const { max_tokens: _limit, ...expected } = body;
  assert.deepEqual(JSON.parse(String(calls[1].body)), { ...expected, parallel_tool_calls: false });
});

test('unrelated errors are returned intact with no extra requests', async () => {
  for (const [status, payload] of [
    [429, JSON.stringify(tokenLimitError)],
    [401, JSON.stringify(tokenLimitError)],
    [500, JSON.stringify(tokenLimitError)],
    [400, 'not JSON'],
    // A parameter name we do not correct. The temperature/top_p/max_tokens
    // wordings ARE corrected (including "Unsupported parameter: 'temperature'",
    // which the GPT-5.x generation uses in place of the older value form), so
    // the pass-through case has to name something else entirely.
    [400, JSON.stringify({ error: { message: "Unsupported parameter: 'frequency_penalty'" } })],
    [400, JSON.stringify({ error: { message: 'max_tokens exceeds context length' } })],
  ] as const) {
    let calls = 0;
    const response = new Response(payload, { status });
    const transport = azureChatFetch(async () => { calls++; return response; });
    const result = await transport(RESOURCE, { body: JSON.stringify({ max_tokens: 512 }) });
    assert.equal(result, response);
    assert.equal(await result.text(), payload, 'error body remains readable by the SDK');
    assert.equal(calls, 1);
  }
});

test('a failed correction is returned without a retry loop', async () => {
  let calls = 0;
  const transport = azureChatFetch(async () => {
    calls++;
    return Response.json(tokenLimitError, { status: 400 });
  });
  const result = await transport(RESOURCE, { body: JSON.stringify({ max_tokens: 512 }) });
  assert.equal(result.status, 400);
  assert.equal(calls, 2);
});

test('newer Azure deployments learn to omit non-default temperature', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.temperature !== undefined) {
      return Response.json({ error: { message: "Unsupported value: 'temperature' does not support 0.6 with this model. Only the default (1) value is supported." } }, { status: 400 });
    }
    return Response.json({ id: 'x', object: 'chat.completion', created: 1, model: 'temperature-only-deployment', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const model = languageModel({ provider: 'azure', model: 'temperature-only-deployment', baseUrl: RESOURCE, apiKey: 'test-key' });
  await generateText({ model, prompt: 'hi', temperature: 0.6, maxOutputTokens: 512, maxRetries: 0 });
  await generateText({ model, prompt: 'hi', temperature: 0.5, maxOutputTokens: 512, maxRetries: 0 });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].temperature, 0.6);
  assert.equal(bodies[1].temperature, undefined);
  assert.equal(bodies[1].max_tokens, 512, 'temperature correction preserves the token dialect');
  assert.equal(bodies[2].temperature, undefined);
});

test('token and temperature corrections can be learned in one bounded request sequence', async () => {
  let calls = 0;
  const transport = azureChatFetch(async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init.body));
    if (body.max_tokens !== undefined) return Response.json(tokenLimitError, { status: 400 });
    if (body.temperature !== undefined) return Response.json({ error: { message: "Unsupported value: 'temperature' does not support 0.6 with this model. Only the default (1) value is supported." } }, { status: 400 });
    return new Response('OK');
  });
  const response = await transport(RESOURCE, { body: JSON.stringify({ max_tokens: 512, temperature: 0.6 }) });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test('newer Azure deployments learn to omit top_p', async () => {
  let calls = 0;
  const transport = azureChatFetch(async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init.body));
    if (body.top_p !== undefined) {
      return Response.json({ error: { message: "Unsupported parameter: 'top_p' is not supported with this model." } }, { status: 400 });
    }
    return new Response('OK');
  });
  const response = await transport(RESOURCE, { body: JSON.stringify({ max_tokens: 512, temperature: 0.5, top_p: 0.9 }) });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  const second = await transport(RESOURCE, { body: JSON.stringify({ max_tokens: 768, temperature: 0.5, top_p: 0.8 }) });
  assert.equal(second.status, 200);
  assert.equal(calls, 3);
});

test('an aborted request cannot start the corrective call', async () => {
  let calls = 0;
  const controller = new AbortController();
  const transport = azureChatFetch(async () => {
    calls++;
    controller.abort();
    return Response.json(tokenLimitError, { status: 400 });
  });
  await assert.rejects(transport(RESOURCE, {
    signal: controller.signal, body: JSON.stringify({ max_tokens: 512 }),
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

test("azure takes openai’s STRUCTURE — native objects, the full discovery budget", () => {
  const azure = capabilitiesFor('azure');
  const openai = capabilitiesFor('openai');
  assert.equal(azure.objectStrategy, 'native');
  assert.equal(azure.discoverySteps, openai.discoverySteps);
  assert.equal(azure.repeatPenaltyApplies, false);
  assert.equal(azure.samplingViaBody, undefined, 'azure takes no llama.cpp body injection');
});

test("azure does NOT take openai’s reasoning levels — a deployment name is not a model id", () => {
  // The whole difference in one place. openai knows exactly what its ids
  // accept, so it reads the id; azure is handed a deployment name, which is an
  // alias, so it reads the operator's declaration instead and the SAME name
  // gives different answers on the two providers.
  //
  // `gpt-5.1-chat` is the name that proved it: it matches openai's family test,
  // took openai's documented suppression floor, and Azure answered "Unsupported
  // value: 'reasoning_effort' does not support 'none' with this model. Supported
  // values are: 'medium'" — a hard 400 mid-segment. So azure never suppresses
  // with a level, and only ever opts IN.
  const args = { modelId: 'gpt-5.1-chat', reasoning: false, forceNoThink: false };
  assert.equal(capabilitiesFor('openai').reasoningLevel(args), 'none');
  assert.equal(capabilitiesFor('azure').reasoningLevel(args), undefined);
  // Chain-of-thought ON is still not enough on azure: the name says nothing
  // about whether the endpoint takes an effort at all, so an undeclared leg
  // omits the parameter. The declared case is covered on its own below.
  assert.equal(capabilitiesFor('azure').reasoningLevel({ ...args, reasoning: true }), undefined);
  assert.equal(
    capabilitiesFor('azure').reasoningLevel({ ...args, reasoning: true, reasoningModelDeclared: true }),
    'medium',
    'medium is the one level every reasoning model accepts');
});

test('a missing endpoint is refused with a message naming the fix', () => {
  assert.throws(
    () => languageModel({ provider: 'azure', model: 'gpt-4o-mini', baseUrl: '' }),
    /no endpoint is set/i,
  );
  // An empty model is refused too — and says DEPLOYMENT, because there is no
  // model list to pick from and "set a model" sends the operator hunting.
  assert.throws(
    () => languageModel({ provider: 'azure', model: '', baseUrl: RESOURCE }),
    /DEPLOYMENT/,
  );
});

test('changing the endpoint rebuilds the model rather than reusing the cached client', () => {
  const a = languageModel({ provider: 'azure', model: 'gpt-4o-mini', baseUrl: RESOURCE });
  assert.equal(languageModel({ provider: 'azure', model: 'gpt-4o-mini', baseUrl: RESOURCE }), a, 'unchanged → cached');
  assert.notEqual(
    languageModel({ provider: 'azure', model: 'gpt-4o-mini', baseUrl: `${RESOURCE}/?api-version=2024-08-01-preview` }),
    a,
    'a different surface must not reuse the client built for the other one',
  );
});

// ---------------------------------------------------------------------------
// Embeddings — the SAME resource, the same key, the same two surfaces
// ---------------------------------------------------------------------------
//
// The tagger's whole enrich -> embed -> seed -> propagate pipeline is dead on an
// Azure-only station unless this path works, and the failure mode is quiet: a
// blank `settings.embedding.provider` means "follow the DJ", so the operator
// never chose azure here and only sees the tagger stop. Every assertion below is
// at the WIRE for the same reason the chat ones are — the SDK assembles the URL
// on top of ours, and the URL that leaves the process is the only thing that
// matters. No credentials, no network.

function captureEmbedFetch(seen: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> }) {
  return (async (url: unknown, init: { headers?: HeadersInit; body?: unknown }) => {
    seen.url = typeof url === 'string' ? url : String(url);
    seen.headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    try { seen.body = JSON.parse(String(init?.body)); } catch { seen.body = undefined; }
    return Response.json({
      object: 'list',
      model: 'text-embedding-3-small',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }) as unknown as typeof fetch;
}

async function embedWith(baseUrl: string, deployment = 'text-embedding-3-small', apiKey = 'test-key') {
  // The embedding builder does not take a `fetch` option (nothing on this path
  // needs one — azureChatFetch corrects chat-completion parameters an embeddings
  // request never carries), so the capture goes on the global.
  const seen: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
  const original = globalThis.fetch;
  globalThis.fetch = captureEmbedFetch(seen);
  try {
    const model = buildEmbeddingModel(
      resolveEmbeddingCfg({ provider: 'azure', model: deployment, baseUrl, apiKey }),
    );
    await embedMany({ model, values: ['subwave embedding probe'] });
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

async function embedProbeWithSavedSettings(overrides: Record<string, string> = {}) {
  const seen: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
  const original = globalThis.fetch;
  globalThis.fetch = captureEmbedFetch(seen);
  try {
    const model = buildEmbeddingModel(resolveEmbeddingCfg(overrides));
    await embedMany({ model, values: ['subwave embedding probe'] });
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

test('embeddings on the modern surface call /openai/v1/embeddings with no api-version', async () => {
  const seen = await embedWith(RESOURCE);
  assert.equal(seen.url, `${RESOURCE}/openai/v1/embeddings`);
  // Azure authenticates with `api-key`, never a bearer Authorization header.
  assert.equal(seen.headers?.['api-key'], 'test-key');
  // The body's `model` is the DEPLOYMENT name, which is the whole Azure quirk.
  assert.equal(seen.body?.model, 'text-embedding-3-small');
});

test('embeddings on the legacy surface call the deployment path with the pinned api-version', async () => {
  const seen = await embedWith(`${RESOURCE}/?api-version=2024-08-01-preview`, 'my-embeddings');
  assert.equal(
    seen.url,
    `${RESOURCE}/openai/deployments/my-embeddings/embeddings?api-version=2024-08-01-preview`,
  );
  assert.equal(seen.body?.model, 'my-embeddings');
});

test('a blank deployment name is refused, not guessed', () => {
  // registry.resolveModelId() makes the same call for chat. Nothing can guess a
  // name the operator invented, and text-embedding-3-small would be a guess
  // dressed as a default — so say what to type instead.
  assert.throws(
    () => buildEmbeddingModel(resolveEmbeddingCfg({ provider: 'azure', model: '', baseUrl: RESOURCE, apiKey: 'k' })),
    /no model is set.*DEPLOYMENT name/s,
  );
});

test('a missing endpoint is named at the point of use, not discovered as a 404', () => {
  assert.throws(
    () => buildEmbeddingModel(resolveEmbeddingCfg({ provider: 'azure', model: 'text-embedding-3-small', baseUrl: '', apiKey: 'k' })),
    /No Azure endpoint is set/,
  );
});

test('the embedding probe classifies both refusals actionably', async () => {
  // The probe is what the admin's "Test embeddings" button and the tagger's
  // preflight both read, so the two config errors have to arrive as their own
  // codes — 'unknown' would print a raw stack where the fix belongs.
  const { probeEmbeddingConfig } = await import('../src/music/embeddings.js');
  const noModel = await probeEmbeddingConfig({ provider: 'azure', model: '', baseUrl: RESOURCE, apiKey: 'k' });
  assert.equal(noModel.code, 'no_model');
  assert.match(noModel.message, /DEPLOYMENT name/);
  const noUrl = await probeEmbeddingConfig({ provider: 'azure', model: 'text-embedding-3-small', baseUrl: '', apiKey: 'k' });
  assert.equal(noUrl.code, 'bad_url');
  assert.match(noUrl.message, /Azure resource endpoint/);
});

test('the deployment list is trimmed by the MODEL behind each deployment', async () => {
  // Azure's deployments API is one mixed list, and the deployment NAME is
  // whatever the operator typed — so a name-only heuristic (what
  // MIXED_MODEL_LIST_PROVIDERS does) both hides real embedding deployments and
  // offers chat ones. The `model` field is the authoritative answer; the name is
  // only the fallback for a resource that omits it.
  const { azureDeploymentIds } = await import('../src/routes/settings/llm.js');
  const list = [
    { id: 'radio-dj', model: 'gpt-4o-mini' },
    { id: 'vectors', model: 'text-embedding-3-small' },
    { id: 'embeddings-chat', model: 'gpt-4o' },
    { id: 'nomic-embed-text' },              // no `model` — fall back to the name
    { id: 'legacy-ada', model: 'text-embedding-ada-002' },
  ];
  assert.deepEqual(
    azureDeploymentIds(list, 'embedding'),
    ['legacy-ada', 'nomic-embed-text', 'vectors'],
  );
  // The chat picker is deliberately untouched: every deployment stays listed.
  assert.deepEqual(
    azureDeploymentIds(list, ''),
    ['embeddings-chat', 'legacy-ada', 'nomic-embed-text', 'radio-dj', 'vectors'],
  );
  // A resource that answers with something unexpected costs the operator the
  // free-text input, never a throw.
  assert.deepEqual(azureDeploymentIds(undefined, 'embedding'), []);
  assert.deepEqual(azureDeploymentIds([{ model: 'text-embedding-3-small' }], 'embedding'), []);
});

test('azure embeddings never inherit a NON-azure chat endpoint', async () => {
  // settings.embedding.baseUrl inherits the chat leg's flat field so a blank one
  // keeps working (#319) — but that field is whatever the DJ's provider set. On
  // a llama.cpp DJ, azureEndpoint() would turn http://host:8080/v1 into a
  // plausible-looking Azure endpoint pointed at the wrong box. Refuse instead.
  await coldLoad({
    provider: 'openai-compatible',
    model: 'qwen3',
    providerBaseUrls: { 'openai-compatible': 'http://host.docker.internal:8080/v1' },
  });
  const { probeEmbeddingConfig } = await import('../src/music/embeddings.js');
  const r = await probeEmbeddingConfig({ provider: 'azure', model: 'text-embedding-3-small' });
  assert.equal(r.code, 'bad_url');

  // ...but when the DJ IS on azure the inheritance is exactly right, and is the
  // common case: a blank embedding provider means "follow the DJ".
  await coldLoad({
    provider: 'azure',
    model: 'gpt-4o-mini',
    providerBaseUrls: { azure: RESOURCE },
    keys: { azure: 'k-azure' },
  });
  // No baseUrl override at all — the endpoint has to come through the chat leg,
  // which is the shape of a station that only ever filled in Settings → LLM.
  // (The deployment name is still required; that is the point of the test above.)
  const seen = await embedProbeWithSavedSettings({ model: 'text-embedding-3-small' });
  assert.equal(seen.url, `${RESOURCE}/openai/v1/embeddings`);
  assert.equal(seen.headers?.['api-key'], 'k-azure');
});

test('an inline azure key reaches the embedding request when the DJ is elsewhere', async () => {
  // The inherited chain ends at the CHAT leg's key, so a station whose DJ is on
  // Ollama but which has an inline Azure key on file would otherwise send none.
  await coldLoad({
    provider: 'ollama',
    model: 'qwen3',
    keys: { azure: 'k-azure-inline' },
  });
  const seen = await embedWith(RESOURCE, 'text-embedding-3-small', '');
  assert.equal(seen.headers?.['api-key'], 'k-azure-inline');
});

// ---------------------------------------------------------------------------
// Registration + the settings round trip
// ---------------------------------------------------------------------------

test('azure is both an LLM and an embedding provider, and its key is a known secret', () => {
  assert.ok(LLM_PROVIDERS.includes('azure'));
  // Azure embeddings are a SEPARATE deployment with its own name, but they are
  // the same resource, the same key and the same two API surfaces — so the
  // picker offers it, and buildEmbeddingModel refuses a blank deployment name
  // rather than falling through to a misleading error (the #493 shape).
  assert.ok(EMBEDDING_PROVIDERS.includes('azure'));
  assert.ok((SECRET_ENV_KEYS as readonly string[]).includes('AZURE_API_KEY'));
});

async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

test('the endpoint and inline key survive a controller restart', async () => {
  const llm = await coldLoad({
    provider: 'azure',
    model: 'gpt-4o-mini',
    providerBaseUrls: { azure: RESOURCE },
    keys: { azure: 'k-azure' },
  });
  assert.equal(llm.providerBaseUrls.azure, RESOURCE);
  assert.equal(settings.llmKeyFor('azure'), 'k-azure');
  // The flat `baseUrl` the registry reads is re-derived from the map on load,
  // so the leg points at the resource without the caller knowing about #1082.
  assert.equal(llm.baseUrl, RESOURCE);
  assert.deepEqual(azureEndpoint(llm), { baseURL: `${RESOURCE}/openai/v1` });
});

test('the fallback leg keeps its own azure endpoint', async () => {
  const llm = await coldLoad({
    provider: 'ollama',
    model: 'qwen3',
    fallback: { enabled: true, provider: 'azure', model: 'gpt-4o-mini', providerBaseUrls: { azure: RESOURCE } },
  });
  assert.equal(llm.fallback.baseUrl, RESOURCE);
  assert.deepEqual(azureEndpoint(llm.fallback), { baseURL: `${RESOURCE}/openai/v1` });
});

test('saving the endpoint through update() then restarting keeps it — the operator story', async () => {
  await coldLoad({ provider: 'ollama', model: 'qwen3' });
  await settings.update({
    llm: { provider: 'azure', model: 'gpt-4o-mini', baseUrl: RESOURCE },
  } as never);
  assert.equal(settings.get().llm.providerBaseUrls.azure, RESOURCE, 'applies immediately');
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.providerBaseUrls.azure, RESOURCE, 'and survives the restart');
  assert.equal(settings.get().llm.baseUrl, RESOURCE);
});

test('an install that never heard of azure loads byte-identically', async () => {
  // The upgrade guarantee: absent keys coerce to the pre-existing behaviour.
  const llm = await coldLoad({ provider: 'ollama', model: 'qwen3' });
  assert.equal(llm.provider, 'ollama');
  assert.equal(llm.baseUrl, '');
  assert.equal(llm.providerBaseUrls.azure, undefined);
  assert.equal(settings.llmKeyFor('azure'), '');
});

// ---------------------------------------------------------------------------
// The dialect learner, and the three ways it used to stop learning.
//
// A gpt-5-class deployment rejects max_tokens, temperature AND top_p. Those are
// exactly the three djText sends (temperature 0.95, topP 0.92, a token cap and
// a seed — llm/internal/prompts/scripts.ts), so this is the DJ's own request
// shape, and the reported failure was "picks work, the DJ is silent".
// ---------------------------------------------------------------------------

function rejectsSamplingParams() {
  let calls = 0;
  const transport = azureChatFetch(async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init!.body));
    // One parameter per answer, which is how Azure reports them.
    if (body.max_tokens !== undefined) return Response.json(tokenLimitError, { status: 400 });
    if (body.temperature !== undefined) {
      return Response.json({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } }, { status: 400 });
    }
    if (body.top_p !== undefined) {
      return Response.json({ error: { message: "Unsupported parameter: 'top_p' is not supported with this model." } }, { status: 400 });
    }
    return new Response('OK');
  });
  return { transport, calls: () => calls };
}

const djTextBody = () => JSON.stringify({
  model: 'radio-dj', max_tokens: 4000, temperature: 0.95, top_p: 0.92, seed: 7,
  messages: [{ role: 'user', content: 'read the link' }],
});

test('all three sampling rejections are learned in one bounded sequence', async () => {
  // The budget was `attempt < 3`: three requests, so two corrections and a
  // send. Three corrections need four, and the DJ's own body needs three.
  const { transport, calls } = rejectsSamplingParams();
  const response = await transport(RESOURCE, { body: djTextBody() });
  assert.equal(response.status, 200, 'the third correction must still be sent');
  assert.equal(calls(), 4, 'one request per correction, plus the one that lands');
});

test('a partly-learned dialect keeps learning — the fast path must not return', async () => {
  // The regression this pins. The first cut returned straight out of the
  // "apply what we know" branch, so once ANY correction was learned no other
  // could ever be: a pick (max_tokens + temperature) taught those two and
  // worked, then every DJ script was corrected for the known two, 400'd on
  // top_p, and handed that 400 back unlearned — forever.
  const { transport, calls } = rejectsSamplingParams();

  // A pick: no top_p, so it learns exactly the two the old code could.
  const pick = await transport(RESOURCE, {
    body: JSON.stringify({ model: 'radio-dj', max_tokens: 8000, temperature: 0.4 }),
  });
  assert.equal(pick.status, 200);
  assert.equal(calls(), 3);

  // Now the DJ speaks. The remaining rejection has to be learned, not returned.
  const script = await transport(RESOURCE, { body: djTextBody() });
  assert.equal(script.status, 200, 'the DJ must not be permanently silent');

  // And the learned dialect then serves the next script in ONE request.
  const before = calls();
  const again = await transport(RESOURCE, { body: djTextBody() });
  assert.equal(again.status, 200);
  assert.equal(calls() - before, 1, 'a fully learned dialect costs no extra requests');
});

test("temperature's newer wording is corrected, not passed through", async () => {
  // Azure changed the failure mode mid-generation: the original gpt-5 rejected
  // a non-default VALUE, and gpt-5.x rejects the PARAMETER's presence whatever
  // its value. Matching only the first left every newer deployment
  // uncorrected — and pinning temperature to 1 to satisfy the value form is
  // exactly the code the parameter form breaks, so both omit the key.
  for (const message of [
    "Unsupported parameter: 'temperature' is not supported with this model.",
    "Unsupported value: 'temperature' does not support 0.6 with this model. Only the default (1) value is supported.",
  ]) {
    const bodies: Record<string, unknown>[] = [];
    const transport = azureChatFetch(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      if (body.temperature !== undefined) return Response.json({ error: { message } }, { status: 400 });
      return new Response('OK');
    });
    const response = await transport(RESOURCE, {
      body: JSON.stringify({ model: 'radio-dj', temperature: 0.6 }),
    });
    assert.equal(response.status, 200, message);
    assert.equal(bodies[1].temperature, undefined, 'omitted, never pinned to 1');
  }
});

test('a declared reasoning deployment is correct on request ONE', async () => {
  // The point of the declaration: no 400 is spent at all. The sniffers stay as
  // the safety net for an operator who left the switch off.
  const bodies: Record<string, unknown>[] = [];
  const transport = azureChatFetch(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    bodies.push(body);
    if (body.max_tokens !== undefined || body.temperature !== undefined || body.top_p !== undefined) {
      return Response.json(tokenLimitError, { status: 400 });
    }
    return new Response('OK');
  }, { reasoningModel: true });
  const response = await transport(RESOURCE, { body: djTextBody() });
  assert.equal(response.status, 200);
  assert.equal(bodies.length, 1, 'no rejection is spent learning what was declared');
  assert.equal(bodies[0].max_completion_tokens, 4000);
  assert.equal(bodies[0].max_tokens, undefined);
  assert.equal(bodies[0].temperature, undefined);
  assert.equal(bodies[0].top_p, undefined);
  // Not seeded: a reasoning deployment is exactly the one that ACCEPTS an
  // effort, and the seed says nothing about which generation it is.
  assert.equal(bodies[0].seed, 7, 'unrelated parameters ride through untouched');
});

test('a deployment that takes no reasoning_effort has it dropped', async () => {
  // `gpt-5-chat` (not a reasoning model) and `o1-mini` (no effort at all) both
  // answer this way, and neither is separable from its reasoning siblings by
  // name — which is why the level is declared rather than inferred.
  const bodies: Record<string, unknown>[] = [];
  const transport = azureChatFetch(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    bodies.push(body);
    if (body.reasoning_effort !== undefined) {
      return Response.json({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }, { status: 400 });
    }
    return new Response('OK');
  });
  const response = await transport(RESOURCE, {
    body: JSON.stringify({ model: 'gpt-5-chat', reasoning_effort: 'medium' }),
  });
  assert.equal(response.status, 200);
  assert.equal(bodies[1].reasoning_effort, undefined);
});

test("gpt-5.6+ teaches reasoning_effort 'none' on tool-bearing requests", async () => {
  // The one correction that ADDS a parameter. It fires even when no effort was
  // sent, because those deployments default to 'medium' — sending `tools` is
  // enough — and the error names its own fix.
  const bodies: Record<string, unknown>[] = [];
  const transport = azureChatFetch(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    bodies.push(body);
    if (Array.isArray(body.tools) && body.reasoning_effort !== 'none') {
      return Response.json({
        error: {
          message: "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
        },
      }, { status: 400 });
    }
    return new Response('OK');
  });
  const response = await transport(RESOURCE, {
    body: JSON.stringify({
      model: 'radio-dj',
      tools: [{ type: 'function', function: { name: 'done', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'pick' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(bodies[1].reasoning_effort, 'none');
});

test('the serial-tool-calls clamp only applies to schema + tools, and is droppable', async () => {
  // Structured outputs and parallel function calls are mutually exclusive on
  // Azure, and the parameter defaults to TRUE — so this is a property of the
  // request SHAPE, not of the deployment, and is not learned. A deployment that
  // refuses the parameter outright (every o-series model) teaches the drop.
  const bodies: Record<string, unknown>[] = [];
  const transport = azureChatFetch(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    bodies.push(body);
    if (body.parallel_tool_calls !== undefined) {
      return Response.json({ error: { message: 'Unrecognized request argument supplied: parallel_tool_calls' } }, { status: 400 });
    }
    return new Response('OK');
  });

  // Tools with no schema: nothing to protect, so nothing is added.
  await transport(RESOURCE, {
    body: JSON.stringify({ model: 'a', tools: [{ type: 'function', function: { name: 'emit' } }] }),
  });
  assert.equal(bodies[0].parallel_tool_calls, undefined);

  // Schema + tools: clamped, then the rejection teaches the drop.
  const response = await transport(RESOURCE, {
    body: JSON.stringify({
      model: 'a',
      tools: [{ type: 'function', function: { name: 'emit' } }],
      response_format: { type: 'json_schema', json_schema: { name: 'pick', schema: { type: 'object' } } },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(bodies[1].parallel_tool_calls, false);
  assert.equal(bodies[2].parallel_tool_calls, undefined, 'the clamp is dropped once refused');
});

test('two deployments on one resource keep separate dialects', async () => {
  // The store is keyed by endpoint path + deployment, so a chat deployment does
  // not inherit a reasoning one's corrections (or pay for them).
  const bodies: Record<string, unknown>[] = [];
  const transport = azureChatFetch(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    bodies.push(body);
    if (body.model === 'reasoner' && body.max_tokens !== undefined) {
      return Response.json(tokenLimitError, { status: 400 });
    }
    return new Response('OK');
  });
  await transport(RESOURCE, { body: JSON.stringify({ model: 'reasoner', max_tokens: 512 }) });
  await transport(RESOURCE, { body: JSON.stringify({ model: 'classic', max_tokens: 512 }) });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1].max_completion_tokens, 512, 'reasoner learned the rename');
  assert.equal(bodies[2].max_tokens, 512, 'classic keeps the SDK dialect');
});

test('an unrecognised 400 is returned before any parameter is touched', async () => {
  // The safety net must not become a retry loop: a real error (a bad prompt, a
  // content filter) has to reach the caller unchanged and cost one request.
  let calls = 0;
  const transport = azureChatFetch(async () => {
    calls++;
    return Response.json({ error: { message: 'The response was filtered due to the prompt triggering a content management policy.' } }, { status: 400 });
  });
  const response = await transport(RESOURCE, { body: djTextBody() });
  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// The declaration, from the descriptor down to the cold load.
// ---------------------------------------------------------------------------

test('reasoning_effort follows the DECLARATION, never the deployment name', () => {
  const azure = capabilitiesFor('azure');
  // The three documented cases a name test gets wrong. `gpt-5-chat` is not a
  // reasoning model, `o1-mini` accepts no effort, and `dj-brain` is a gpt-5
  // deployment that no pattern matches — so with the switch off, nothing is
  // sent, and with it on, every one of them gets the single level every
  // reasoning model accepts.
  for (const modelId of ['gpt-5-chat', 'o1-mini', 'dj-brain', 'gpt-5.1-chat', 'gpt-4o-mini']) {
    assert.equal(
      azure.reasoningLevel({ modelId, reasoning: true, forceNoThink: false }),
      undefined,
      `${modelId}: an undeclared leg must send no effort`,
    );
    assert.equal(
      azure.reasoningLevel({ modelId, reasoning: true, forceNoThink: false, reasoningModelDeclared: true }),
      'medium',
      `${modelId}: a declared leg opts in at 'medium'`,
    );
  }
  // The declaration says what the endpoint ACCEPTS; `reasoning` says what the
  // operator WANTS. Both are required to send anything.
  assert.equal(
    azure.reasoningLevel({ modelId: 'dj-brain', reasoning: false, forceNoThink: false, reasoningModelDeclared: true }),
    undefined,
    'chain-of-thought off omits the parameter rather than suppressing with a level',
  );
});

test('the reasoning-deployment switch survives a controller restart, both legs', async () => {
  // A cold round trip, like llm-repeat-penalty.test.ts: this block does not
  // spread DEFAULTS, so a missing line in load()'s composition would let the
  // operator's tick live in memory for one process and vanish on restart —
  // after which the DJ starts spending 400s to relearn what was declared.
  const llm = await coldLoad({
    provider: 'azure',
    model: 'radio-dj',
    providerBaseUrls: { azure: RESOURCE },
    reasoningModel: true,
    fallback: { enabled: true, provider: 'azure', model: 'backup-dj', reasoningModel: true },
  });
  assert.equal(llm.reasoningModel, true);
  assert.equal(llm.fallback.reasoningModel, true);
  // A settings.json written before the field existed reads false, which is the
  // pre-existing behaviour exactly.
  const legacy = await coldLoad({ provider: 'azure', model: 'radio-dj' });
  assert.equal(legacy.reasoningModel, false);
  assert.equal(legacy.fallback.reasoningModel, false);
});

test('the switch reaches the built client, so a save is not ignored until restart', async () => {
  // It keys the client cache (`rm…`) for the same reason repeat_penalty and the
  // custom headers do: the azure client is built around a transport the flag
  // chooses, so without it the operator ticks the box, saves, and keeps being
  // served the instance wired to the un-seeded transport.
  const bodies: Record<string, unknown>[] = [];
  const success = captureFetch({});
  const t = { restore: () => {} };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.max_tokens !== undefined) return Response.json(tokenLimitError, { status: 400 });
    return success(url as string, init);
  }) as unknown as typeof fetch;
  t.restore = () => { globalThis.fetch = original; };
  try {
    const base = { provider: 'azure', model: 'declared-dj', baseUrl: RESOURCE, apiKey: 'test-key' };
    const declared = languageModel({ ...base, reasoningModel: true });
    await generateText({ model: declared, prompt: 'hi', maxOutputTokens: 512, maxRetries: 0 });
    assert.equal(bodies.length, 1, 'a declared leg spends no rejection');
    assert.equal(bodies[0].max_completion_tokens, 512);

    // Same provider/model/key: only the flag differs, so only the signature can
    // keep these apart.
    bodies.length = 0;
    const undeclared = languageModel({ ...base, model: 'undeclared-dj', reasoningModel: false });
    await generateText({ model: undeclared, prompt: 'hi', maxOutputTokens: 512, maxRetries: 0 });
    assert.equal(bodies.length, 2, 'an undeclared leg learns from the rejection');
    assert.equal(bodies[0].max_tokens, 512);
    assert.equal(bodies[1].max_completion_tokens, 512);
  } finally {
    t.restore();
  }
});

test('a Foundry project endpoint is passed through, not appended to', async () => {
  // @ai-sdk/azure recognises this shape itself and routes it to `<base>/v1`
  // with no api-version. Appending /openai/v1 produced
  // …/api/projects/<proj>/openai/v1/chat/completions — a 404, which is the
  // silent DJ this resolver exists to prevent.
  const project = 'https://my-res.services.ai.azure.com/api/projects/radio';
  assert.deepEqual(azureEndpoint({ baseUrl: project }), { baseURL: project });
  assert.deepEqual(azureEndpoint({ baseUrl: `${project}/` }), { baseURL: project });
  // An endpoint already carrying the modern path keeps it, as before.
  assert.deepEqual(
    azureEndpoint({ baseUrl: `${RESOURCE}/openai/v1` }),
    { baseURL: `${RESOURCE}/openai/v1` },
  );
  // A project endpoint pinned to a dated api-version still takes the legacy
  // path, because that is what the operator asked for.
  const pinned = azureEndpoint({ baseUrl: `${project}?api-version=2025-04-01-preview` });
  assert.equal(pinned.useDeploymentBasedUrls, true);
  assert.equal(pinned.apiVersion, '2025-04-01-preview');
});
