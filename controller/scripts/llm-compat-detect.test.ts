// Auto-detecting what an openai-compatible connection talks to (compat-detect)
// and the doctor finding that names a mismatch. The classifier and the doctor
// finding are pure; the probe runs against a stub fetcher, never a network.
//
// Pinned rules:
// - A self-hosted signature beats every hosted hint; no evidence is `local`.
// - `auto` is the default for a new station only: a stored llm block without
//   the key keeps `local`, so an upgrade is driven exactly as before.
// - An explicit operator choice is never rewritten.
import assert from 'node:assert/strict';
import { coldLoadSettings } from './test-utils/settings.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-compat-detect-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'compat-test';
process.env.ADMIN_PASS = 'compat-test';

const {
  classifyCompatibleServer, probeCompatibleServer, resolveCompatibleMode, detectCompatibleMode,
  clearCompatDetectionCache, isPublicHttpsHost, isCloudModelId,
} = await import('../src/llm/internal/provider/compat-detect.js');
const { compatModeFinding, agentRecoveryRate } = await import('../src/doctor/checks-services.js');
const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { llmCfg } = await import('../src/llm/internal/provider/registry.js');
const { discoveryStepsFor, needsToolCallObject } = await import('../src/llm/internal/provider/capabilities.js');
after(() => clearCompatDetectionCache());

const LOCAL_URL = 'http://192.168.1.20:8080/v1';

test('self-hosted signatures classify as local, whatever else is listed', () => {
  assert.equal(classifyCompatibleServer({ baseUrl: LOCAL_URL, llamaCppProps: true, model: 'claude-x' }).server, 'llama.cpp',
    'a llama.cpp /props answer wins even over a cloud-looking model id');
  assert.equal(classifyCompatibleServer({ baseUrl: LOCAL_URL, lmStudioApi: true }).server, 'lm-studio');
  assert.equal(classifyCompatibleServer({ baseUrl: LOCAL_URL, ollamaVersion: true }).server, 'ollama');
  for (const [owner, server] of [['llamacpp', 'llama.cpp'], ['vllm', 'vllm'], ['organization_owner', 'lm-studio'], ['koboldcpp', 'local-server']]) {
    const d = classifyCompatibleServer({ baseUrl: LOCAL_URL, modelsOwnedBy: [owner] });
    assert.deepEqual([d.mode, d.server], ['local', server], owner);
  }
});

test('a cloud model or a public HTTPS API classifies as hosted', () => {
  assert.equal(classifyCompatibleServer({ baseUrl: 'http://100.116.0.5:8317/v1', model: 'claude-sonnet-5-5' }).mode, 'hosted',
    'a proxy on a Tailscale address serving a cloud model is hosted');
  assert.equal(classifyCompatibleServer({ baseUrl: 'http://10.0.0.2:4000/v1', modelIds: ['gpt-5', 'local-thing'] }).mode, 'hosted',
    'with no model chosen, a listed cloud id is enough');
  assert.equal(classifyCompatibleServer({ baseUrl: 'https://api.mistral.ai/v1', model: 'open-mixtral' }).mode, 'hosted');
  assert.equal(classifyCompatibleServer({ baseUrl: 'http://10.0.0.2:4000/v1', model: 'my-finetune', modelIds: ['gpt-5'] }).mode, null,
    'a chosen non-cloud model is not overridden by what else the router lists');
});

test('no positive evidence is undecided, never hosted', () => {
  assert.equal(classifyCompatibleServer({ baseUrl: LOCAL_URL, model: 'qwen3-14b', reachable: true }).mode, null);
  assert.equal(classifyCompatibleServer({ baseUrl: 'http://box.lan:8080/v1', model: 'qwen3-14b' }).mode, null);
  assert.equal(classifyCompatibleServer({ baseUrl: 'https://llm.home.arpa/v1', model: 'qwen3' }).mode, null);
});

test('host and model helpers', () => {
  assert.equal(isPublicHttpsHost('https://api.groq.com/openai/v1'), true);
  assert.equal(isPublicHttpsHost('http://api.groq.com/openai/v1'), false, 'plain http is not evidence');
  assert.equal(isPublicHttpsHost('https://192.168.1.2/v1'), false);
  assert.equal(isPublicHttpsHost('https://gpu.tail1234.ts.net/v1'), false);
  assert.equal(isPublicHttpsHost('not a url'), false);
  for (const id of ['claude-haiku-5-5', 'gpt-5.1', 'openai/gpt-4o', 'o3-mini', 'gemini-2.5-pro', 'anthropic/claude-opus-5']) assert.ok(isCloudModelId(id), id);
  for (const id of ['qwen3-14b', 'llama-3.1-8b', 'mistral-7b-instruct', 'gemma-3-12b', 'omega-v2']) assert.ok(!isCloudModelId(id), id);
});

type Routes = Record<string, { status?: number; body?: unknown } | 'down'>;
function stubFetcher(routes: Routes, seen: string[] = []) {
  return async (url: string, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as Record<string, string>)?.Authorization ?? ''}`);
    const r = routes[url];
    if (!r || r === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
}

test('the probe reads llama.cpp from /props at the server root', async () => {
  const seen: string[] = [];
  const d = await probeCompatibleServer({ baseUrl: `${LOCAL_URL}/`, model: 'qwen3', apiKey: 'k' }, {
    fetcher: stubFetcher({
      'http://192.168.1.20:8080/v1/models': { body: { data: [{ id: 'qwen3', owned_by: 'llamacpp' }] } },
      'http://192.168.1.20:8080/props': { body: { default_generation_settings: {}, total_slots: 1 } },
    }, seen),
  });
  assert.deepEqual([d.mode, d.server], ['local', 'llama.cpp']);
  assert.ok(seen.every(line => line.endsWith('Bearer k')), 'every probe carries the configured key');
});

test('the probe calls a cloud-model proxy hosted, and an unreachable server undecided', async () => {
  const proxy = await probeCompatibleServer({ baseUrl: 'http://100.116.0.5:8317/v1', model: 'claude-sonnet-5-5' }, {
    fetcher: stubFetcher({
      'http://100.116.0.5:8317/v1/models': { body: { data: [{ id: 'claude-sonnet-5-5', owned_by: 'anthropic' }] } },
      'http://100.116.0.5:8317/props': { status: 404 },
      'http://100.116.0.5:8317/api/v0/models': { status: 404 },
      'http://100.116.0.5:8317/api/version': { status: 404 },
    }),
  });
  assert.equal(proxy.mode, 'hosted');
  const down = await probeCompatibleServer({ baseUrl: LOCAL_URL, model: 'qwen3' }, { fetcher: stubFetcher({}) });
  assert.deepEqual([down.mode, down.evidence], [null, 'server unreachable']);
});

test('resolveCompatibleMode rewrites only auto on openai-compatible, and only from the cache', async () => {
  clearCompatDetectionCache();
  const explicit = { provider: 'openai-compatible', compatibleMode: 'local', baseUrl: LOCAL_URL, model: 'claude-x' };
  assert.equal(resolveCompatibleMode(explicit), explicit, 'an explicit choice is returned untouched');
  const other = { provider: 'ollama', compatibleMode: 'auto' };
  assert.equal(resolveCompatibleMode(other), other, 'auto means nothing to another provider');

  const auto = { provider: 'openai-compatible', compatibleMode: 'auto', baseUrl: 'http://proxy.invalid/v1', model: 'claude-sonnet-5-5' };
  assert.equal(resolveCompatibleMode(auto).compatibleMode, 'local', 'before any detection, auto runs as local');
  await detectCompatibleMode(auto, { fetcher: stubFetcher({ 'http://proxy.invalid/v1/models': { body: { data: [] } } }) });
  const resolved = resolveCompatibleMode(auto) as typeof auto & { compatibleModeSetting?: string };
  assert.deepEqual([resolved.compatibleMode, resolved.compatibleModeSetting], ['hosted', 'auto']);
  assert.equal(needsToolCallObject(resolved), false, 'downstream capabilities see hosted');
  assert.equal(discoveryStepsFor(resolved), 3);
});

async function coldLoad(stored: Record<string, unknown>) { await coldLoadSettings(stored); }

test('auto is the default for a new station only; a stored block keeps local', async () => {
  await coldLoad({});
  assert.equal(settings.get().llm.compatibleMode, 'auto', 'a station with no llm block yet');
  assert.equal(settings.get().llm.fallback.compatibleMode, 'auto');

  await coldLoad({ llm: { provider: 'openai-compatible', model: 'm', baseUrl: LOCAL_URL, fallback: { provider: 'ollama' } } });
  assert.equal(settings.get().llm.compatibleMode, 'local', 'a block written before auto existed is unchanged');
  assert.equal(settings.get().llm.fallback.compatibleMode, 'local');

  await coldLoad({ llm: { provider: 'openai-compatible', model: 'm', baseUrl: LOCAL_URL, compatibleMode: 'auto', fallback: { compatibleMode: 'hosted' } } });
  assert.equal(settings.get().llm.compatibleMode, 'auto');
  assert.equal(settings.get().llm.fallback.compatibleMode, 'hosted');
  await coldLoad({ llm: { compatibleMode: 'bogus' } });
  assert.equal(settings.get().llm.compatibleMode, 'local', 'an unreadable value loads as local');
});

test('auto survives a save and a cold load, and the validator accepts it', async () => {
  await coldLoad({ llm: { provider: 'openai-compatible', model: 'm', baseUrl: LOCAL_URL } });
  await settings.update({ llm: { compatibleMode: 'auto', fallback: { compatibleMode: 'auto' } } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.compatibleMode, 'auto');
  assert.equal(settings.get().llm.fallback.compatibleMode, 'auto');
  await assert.rejects(settings.update({ llm: { compatibleMode: 'other' } } as never), /"local", "hosted" or "auto"/);
});

test('llmCfg hands downstream code the resolved mode', async () => {
  clearCompatDetectionCache();
  await coldLoad({ llm: { provider: 'openai-compatible', model: 'claude-haiku-5-5', baseUrl: 'http://proxy2.invalid/v1', compatibleMode: 'auto' } });
  assert.equal(llmCfg().compatibleMode, 'local');
  await detectCompatibleMode(settings.get().llm, { fetcher: stubFetcher({}) });
  assert.equal(llmCfg().compatibleMode, 'hosted', 'the cloud model id decides even with the server down');
});

const detection = (mode: 'local' | 'hosted' | null, server: string | null = mode === 'hosted' ? 'hosted-api' : mode ? 'llama.cpp' : null) =>
  ({ mode, server, evidence: 'stub', at: 0 }) as Parameters<typeof compatModeFinding>[2];
const none = { agentCalls: 0, recoveries: 0 };

test('doctor warns on a mismatch with evidence behind it, and only then', () => {
  assert.equal(compatModeFinding('connection mode', 'local', detection('hosted'), none).status, 'warn');
  assert.equal(compatModeFinding('connection mode', 'hosted', detection('local'), none).status, 'warn');
  assert.equal(compatModeFinding('connection mode', 'local', detection(null), none).status, 'ok',
    'an undecided probe alone is not a warning');
  assert.equal(compatModeFinding('connection mode', 'local', detection(null), { agentCalls: 6, recoveries: 5 }).status, 'warn',
    'the runtime recovery pattern is evidence on its own');
  assert.equal(compatModeFinding('connection mode', 'local', detection(null), { agentCalls: 3, recoveries: 3 }).status, 'ok',
    'three calls are not a pattern');
  assert.equal(compatModeFinding('connection mode', 'local', detection('local'), none).status, 'ok');
  assert.equal(compatModeFinding('connection mode', 'hosted', detection('hosted'), none).status, 'ok');
  const auto = compatModeFinding('connection mode', 'auto', detection('hosted'), none);
  assert.equal(auto.status, 'ok');
  assert.match(auto.detail ?? '', /Auto-detect → hosted/);
  assert.match(compatModeFinding('connection mode', 'local', detection('hosted'), { agentCalls: 7, recoveries: 7 }).detail ?? '',
    /7\/7 recent agent calls needed the done-only recovery/);
});

test('the recovery rate counts this leg\'s agent calls only', () => {
  const calls = [
    { model: 'openai-compatible:m', via: 'ai-sdk:agent:recovery' },
    { model: 'openai-compatible:m', via: 'ai-sdk:agent' },
    { model: 'openai-compatible:m', via: 'ai-sdk:tool' },
    { model: 'openrouter:x', via: 'ai-sdk:agent:recovery' },
  ];
  assert.deepEqual(agentRecoveryRate({ label: 'openai-compatible:m' }, calls), { agentCalls: 2, recoveries: 1 });
});
