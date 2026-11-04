// Hosted mode (SUBWAVE_HOSTED=1, setup/hosted.ts): on a station run by
// SUB/WAVE Cloud the box agent owns the LLM route and the voice engine, and
// writes them into settings.json itself. Neither the first-run wizard nor the
// settings API may overwrite them, while everything the operator still owns
// (station name, whether the DJ speaks, the Kokoro voice, gain, corrections,
// non-voice API keys) saves as usual. /onboarding/status says it's hosted so
// the wizard can skip the steps.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the routers
// mount bare over real HTTP against a temp state dir.
//
// Run: `npm test -- hosted-mode`.

import assert from 'node:assert/strict';
import { listen as listenHttp } from './test-utils/http.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-hosted-mode-'));
process.env.STATE_DIR = stateRoot;
process.env.SUBWAVE_HOSTED = '1';
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

// What the box agent writes before the station first boots.
const MANAGED = {
  llm: { provider: 'openai-compatible', model: 'dj-brain', baseUrl: 'https://brain.example/v1' },
  tts: { defaultEngine: 'kokoro', cloud: { enabled: false }, kokoro: { voice: 'bf_isabella', lang: 'en-gb' } },
};
writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify(MANAGED));

const express = (await import('express')).default;
const { router: onboarding } = await import('../src/routes/onboarding.js');
const { router: settingsCore } = await import('../src/routes/settings/core.js');
const settings = await import('../src/settings.js');
const { hostedPersonaEngines, stripManagedSecrets, stripManagedSettings } = await import('../src/setup/hosted.js');

const app = express();
app.use(express.json());
app.use(onboarding);
app.use(settingsCore);
const { server, url: base } = await listenHttp(app);
server.unref();

async function post(p: string, body: unknown) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

const stored = () => JSON.parse(readFileSync(path.join(stateRoot, 'settings.json'), 'utf8'));

test('status tells the wizard the station is hosted', async () => {
  const status = await (await fetch(`${base}/onboarding/status`)).json() as any;
  assert.equal(status.hosted, true);
});

test('the wizard save keeps the managed LLM and engine, applies the rest', async () => {
  const r = await post('/onboarding/save', {
    navidrome: { url: '', user: '', pass: '' },
    llm: { provider: 'ollama', model: 'glm-5.1:cloud' },
    tts: { defaultEngine: 'piper', cloud: { enabled: false } },
    apiKeys: { OPENAI_API_KEY: 'sk-nope', SEARCH_API_KEY: 'search-ok' },
    station: 'Pilot FM',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await settings.load();
  const s = settings.get() as any;
  assert.equal(s.llm.provider, 'openai-compatible');
  assert.equal(s.llm.model, 'dj-brain');
  assert.equal(s.tts.defaultEngine, 'kokoro');
  assert.equal(s.station, 'Pilot FM');
  const secrets = readFileSync(path.join(stateRoot, 'secrets.env'), 'utf8');
  assert.match(secrets, /SEARCH_API_KEY/);
  assert.doesNotMatch(secrets, /OPENAI_API_KEY/);
});

test('a settings save drops managed keys, keeps operator ones, and says what it dropped', async () => {
  const r = await post('/settings', {
    llm: { provider: 'ollama' },
    tts: { defaultEngine: 'cloud', enabled: false, kokoro: { voice: 'bm_george', lang: 'en-gb' } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.managed, ['llm', 'tts.defaultEngine']);
  const s = stored();
  assert.equal(s.llm.provider, 'openai-compatible');
  assert.equal(s.tts.defaultEngine, 'kokoro');
  assert.equal(s.tts.enabled, false);
  assert.equal(s.tts.kokoro.voice, 'bm_george');
});

test('the LLM swap is refused, and secrets keep only non-LLM, non-voice keys', async () => {
  assert.equal((await post('/settings/llm/swap', {})).status, 403);
  const r = await post('/settings/secrets', { ANTHROPIC_API_KEY: 'sk-ant-nope', ELEVENLABS_API_KEY: 'el-nope', LASTFM_API_KEY: 'lfm-ok' });
  assert.deepEqual(r.body.saved, ['LASTFM_API_KEY']);
});

test('the strip helpers: managed paths only, never mutating the input', () => {
  const input = { llm: { model: 'x' }, tts: { fallback: { enabled: true }, gainDb: { kokoro: 2 } }, station: 'A' };
  const { patch, dropped } = stripManagedSettings(input);
  assert.deepEqual(patch, { tts: { gainDb: { kokoro: 2 } }, station: 'A' });
  assert.deepEqual(dropped, ['llm', 'tts.fallback']);
  assert.ok('llm' in input);
  assert.deepEqual(stripManagedSecrets({ OPENAI_API_KEY: 'a', FISH_API_KEY: 'b', SEARCH_API_KEY: 'c' }), { SEARCH_API_KEY: 'c' });
});

test('the embedding route is managed; the tagger tuning still saves', async () => {
  const r = await post('/settings', {
    embedding: { provider: 'openai', model: 'text-embedding-3-large', apiKey: 'sk-nope', enabled: false, seedCount: 300 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.managed, ['embedding.provider', 'embedding.model', 'embedding.apiKey']);
  const e = stored().embedding;
  assert.notEqual(e.provider, 'openai');
  assert.notEqual(e.model, 'text-embedding-3-large');
  assert.equal(e.enabled, false);
  assert.equal(e.seedCount, 300);
  const keys = await post('/settings/secrets', { EMBEDDING_API_KEY: 'sk-nope' });
  assert.deepEqual(keys.body.saved, []);
});

test('a persona may pin only the box engines (or the cloud voice on premium); others become inherit', () => {
  assert.deepEqual(hostedPersonaEngines('kokoro'), ['inherit', 'kokoro', 'piper']);
  assert.deepEqual(hostedPersonaEngines('cloud'), ['inherit', 'kokoro', 'piper', 'cloud']);
  const personas = [
    { id: 'a', tts: { engine: 'kokoro', voice: 'bm_george' } },
    { id: 'b', tts: { engine: 'chatterbox', voice: 'clip.wav' } },
    { id: 'c', tts: { engine: 'cloud', voice: 'alloy' } },
    { id: 'd', name: 'no tts block' },
  ];
  const base = stripManagedSettings({ personas }, { defaultEngine: 'kokoro' });
  assert.deepEqual(base.patch.personas.map((p: any) => p.tts?.engine), ['kokoro', 'inherit', 'inherit', undefined]);
  assert.equal(base.patch.personas[1].tts.voice, 'clip.wav'); // only the engine changes
  assert.deepEqual(base.dropped, ['personas.b.tts.engine', 'personas.c.tts.engine']);
  const premium = stripManagedSettings({ personas }, { defaultEngine: 'cloud' });
  assert.deepEqual(premium.patch.personas.map((p: any) => p.tts?.engine), ['kokoro', 'inherit', 'cloud', undefined]);
});
