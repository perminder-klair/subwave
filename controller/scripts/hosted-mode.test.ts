// Hosted mode (SUBWAVE_HOSTED=1, setup/hosted.ts): on a station run by
// SUB/WAVE Cloud the box agent owns the LLM route and the voice engine, and
// writes them into settings.json itself. Neither the first-run wizard, the
// settings API, a backup restore nor a persona import may overwrite them,
// while everything the operator still owns (station name, whether the DJ
// speaks, the Kokoro voice, gain, corrections, non-voice API keys) saves as
// usual, and every one of those writes names what it left alone (`managed`).
// /onboarding/status says it's hosted so the wizard can skip the steps. The
// env is read through util/env.ts: a malformed value warns once and is unset.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the routers
// mount bare over real HTTP against a temp state dir.
//
// Run: `npm test -- hosted-mode`.

import assert from 'node:assert/strict';
import { listen as listenHttp } from './test-utils/http.js';
import { readFileSync, writeFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
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
const { router: backup } = await import('../src/routes/backup.js');
const { BACKUP_FORMAT, BACKUP_VERSION } = await import('../src/backup/zip.js');
const settings = await import('../src/settings.js');
const {
  advertisedMounts, capStreamBitrates, HOSTED_LLM_KEYS, HOSTED_OPERATOR_LEG_FIELDS, hostedMaxBitrate,
  hostedPersonaEngines, hostedVoiceSlot, isHosted, stripManagedSecrets, stripManagedSettings,
} = await import('../src/setup/hosted.js');
const { HOSTED_MIN_BITRATE } = await import('../src/schemas/hosted.js');
const { SETTINGS_MP3_BITRATES } = await import('../src/schemas/settings.js');
const { LLM_LEG_FIELDS } = await import('../src/settings/llm-swap.js');
const { envIssues } = await import('../src/util/env.js');
const { installPersona } = await import('../src/personas/install.js');

const app = express();
app.use(express.json());
app.use(onboarding);
app.use(settingsCore);
app.use(backup);
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
  // The reply names what it left alone, as POST /settings does.
  for (const path of ['llm.provider', 'llm.model', 'tts.defaultEngine', 'tts.cloud', 'apiKeys.OPENAI_API_KEY']) {
    assert.ok(r.body.managed.includes(path), `${path} in ${JSON.stringify(r.body.managed)}`);
  }
  assert.ok(!r.body.managed.includes('apiKeys.SEARCH_API_KEY'));
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
  assert.deepEqual(r.body.managed, ['llm.provider', 'tts.defaultEngine']);
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
  assert.deepEqual(r.body.managed, ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY']);
});

test('the strip helpers: managed paths only, never mutating the input', () => {
  const input = { llm: { model: 'x' }, tts: { fallback: { enabled: true }, gainDb: { kokoro: 2 } }, station: 'A' };
  const { patch, dropped } = stripManagedSettings(input);
  assert.deepEqual(patch, { tts: { gainDb: { kokoro: 2 } }, station: 'A' });
  assert.deepEqual(dropped, ['llm.model', 'tts.fallback']);
  assert.ok('llm' in input);
  assert.deepEqual(stripManagedSecrets({ OPENAI_API_KEY: 'a', FISH_API_KEY: 'b', SEARCH_API_KEY: 'c' }),
    { patch: { SEARCH_API_KEY: 'c' }, dropped: ['OPENAI_API_KEY', 'FISH_API_KEY'] });
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
  assert.deepEqual(keys.body.managed, ['EMBEDDING_API_KEY']);
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

test('DJ tuning that lives under llm still saves; only the LLM route is managed', async () => {
  const r = await post('/settings', { llm: { provider: 'ollama', noRepeatWindow: 40, artistVarietyWindow: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.managed, ['llm.provider']);
  const llm = stored().llm;
  assert.equal(llm.provider, 'openai-compatible');
  assert.equal(llm.noRepeatWindow, 40);
  assert.equal(llm.artistVarietyWindow, 3);
});

test('an imported or installed persona gets the hosted engine rule too', async () => {
  // A complete persona, as a bundle carries one: a stock persona under a new
  // name, pinned to an engine hosted boxes don't run.
  const { id: _id, ...stock } = (settings.get() as any).personas[0];
  const r = await installPersona({ ...stock, name: 'Bundle DJ', tts: { ...stock.tts, engine: 'chatterbox', voice: 'clip.wav' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ok && r.managed, ['tts.engine']);
  const p = stored().personas.find((x: any) => x.name === 'Bundle DJ');
  assert.equal(p.tts.engine, 'inherit');
});

test('the voice-slot engine rule: one copy, for personas and jingles, a no-op self-hosted', () => {
  assert.deepEqual(hostedVoiceSlot({ engine: 'kokoro', voice: 'bm_george' }, 'kokoro'), { slot: { engine: 'kokoro', voice: 'bm_george' }, changed: false });
  assert.deepEqual(hostedVoiceSlot({ engine: 'gemini', voice: 'Kore' }, 'kokoro'), { slot: { engine: 'inherit', voice: 'Kore' }, changed: true });
  assert.deepEqual(hostedVoiceSlot(undefined, 'kokoro'), { slot: undefined, changed: false });
  delete process.env.SUBWAVE_HOSTED;
  try {
    assert.deepEqual(hostedVoiceSlot({ engine: 'gemini' }, 'kokoro'), { slot: { engine: 'gemini' }, changed: false });
  } finally {
    process.env.SUBWAVE_HOSTED = '1';
  }
});

test('a backup restore keeps the managed settings and applies the rest, and says what it kept', async () => {
  // A backup from the owner's self-hosted station: its own LLM, voice engine,
  // embedding route, listener ceiling and a persona pinned to a heavy engine.
  const [first, ...rest] = (settings.get() as any).personas;
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION })));
  zip.addFile('settings.json', Buffer.from(JSON.stringify({
    station: 'Restored FM',
    llm: { provider: 'ollama', model: 'llama3.1:8b', ollamaUrl: 'http://home-box:11434', noRepeatWindow: 55 },
    tts: { defaultEngine: 'piper', enabled: true },
    embedding: { provider: 'ollama', model: 'nomic-embed-text', seedCount: 120 },
    stream: { maxListeners: 99, idleWhenEmpty: false },
    personas: [{ ...first, tts: { ...first.tts, engine: 'chatterbox', voice: 'clip.wav' } }, ...rest],
  })));
  const res = await fetch(`${base}/backup/import`, { method: 'POST', body: new Uint8Array(zip.toBuffer()) });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  for (const path of ['llm.provider', 'llm.model', 'llm.ollamaUrl', 'tts.defaultEngine', 'embedding.provider', 'embedding.model', 'stream.maxListeners', `personas.${first.id}.tts.engine`]) {
    assert.ok(body.managed.includes(path), `${path} in ${JSON.stringify(body.managed)}`);
  }
  const s = stored();
  assert.equal(s.station, 'Restored FM');
  assert.equal(s.llm.provider, 'openai-compatible');
  assert.equal(s.llm.model, 'dj-brain');
  assert.equal(s.llm.noRepeatWindow, 55);
  assert.equal(s.tts.defaultEngine, 'kokoro');
  assert.notEqual(s.embedding.provider, 'ollama');
  assert.equal(s.embedding.seedCount, 120);
  assert.equal(s.stream.idleWhenEmpty, false);
  assert.equal(s.personas.find((p: any) => p.id === first.id).tts.engine, 'inherit');
});

test('the listener ceiling is the box agent\'s: a hosted save drops stream.maxListeners, keeps the rest', async () => {
  const before = stored().stream?.maxListeners;
  const r = await post('/settings', { stream: { maxListeners: 37, idleWhenEmpty: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.managed, ['stream.maxListeners']);
  const st = stored().stream;
  assert.equal(st.maxListeners, before);
  assert.equal(st.idleWhenEmpty, true);
});

test('the station\'s bitrate ceiling caps every listener mount and switches FLAC off', () => {
  const stream = { bitrate: 320, aacEnabled: true, aacBitrate: 256, opusEnabled: true, opusBitrate: 320, flacEnabled: true };
  assert.deepEqual(capStreamBitrates(stream, 192),
    { bitrate: 192, aacEnabled: true, aacBitrate: 192, opusEnabled: true, opusBitrate: 192, flacEnabled: false });
  // 256: MP3 has no 256, so it lands on 192; AAC and Opus keep 256.
  assert.deepEqual(capStreamBitrates(stream, 256),
    { bitrate: 192, aacEnabled: true, aacBitrate: 256, opusEnabled: true, opusBitrate: 256, flacEnabled: false });
  // Under AAC's lowest (128): AAC goes off rather than over the ceiling.
  assert.equal(capStreamBitrates(stream, 96).aacEnabled, false);
  assert.equal(capStreamBitrates(stream, 96).bitrate, 96);
  // No ceiling: untouched.
  assert.deepEqual(capStreamBitrates(stream, undefined), stream);
});

test('SUBWAVE_MAX_BITRATE is read only on a hosted station, and over-ceiling saves are dropped', async () => {
  process.env.SUBWAVE_MAX_BITRATE = '192';
  try {
    delete process.env.SUBWAVE_HOSTED;
    assert.equal(hostedMaxBitrate(), undefined);
    process.env.SUBWAVE_HOSTED = '1';
    assert.equal(hostedMaxBitrate(), 192);
    const { patch, dropped } = stripManagedSettings({ stream: { bitrate: 320, opusBitrate: 128, flacEnabled: true } });
    assert.deepEqual(patch, { stream: { opusBitrate: 128 } });
    assert.deepEqual(dropped.sort(), ['stream.bitrate', 'stream.flacEnabled']);
  } finally {
    process.env.SUBWAVE_HOSTED = '1';
    delete process.env.SUBWAVE_MAX_BITRATE;
  }
});

test('a malformed SUBWAVE_MAX_BITRATE warns once and means no ceiling; one under MP3\'s lowest is malformed', () => {
  // MP3 is always served, so a ceiling under its lowest bitrate can't be honoured.
  assert.equal(HOSTED_MIN_BITRATE, Math.min(...SETTINGS_MP3_BITRATES));
  for (const value of ['fast', '48', '19.5']) {
    process.env.SUBWAVE_MAX_BITRATE = value;
    try {
      const before = envIssues().length;
      assert.equal(hostedMaxBitrate(), undefined, value);
      assert.equal(hostedMaxBitrate(), undefined, value);
      assert.equal(envIssues().length, before + 1, `${value} warns once, not once per read`);
      const issue = envIssues().at(-1)!;
      assert.equal(issue.name, 'SUBWAVE_MAX_BITRATE');
      assert.equal(issue.usedInstead, 'no bitrate ceiling');
    } finally {
      delete process.env.SUBWAVE_MAX_BITRATE;
    }
  }
});

test('a malformed SUBWAVE_HOSTED warns and reads as self-hosted', () => {
  process.env.SUBWAVE_HOSTED = 'ture';
  try {
    const before = envIssues().length;
    assert.equal(isHosted(), false);
    assert.equal(envIssues().length, before + 1);
    assert.equal(envIssues().at(-1)!.name, 'SUBWAVE_HOSTED');
    process.env.SUBWAVE_HOSTED = ' On ';
    assert.equal(isHosted(), true);
  } finally {
    process.env.SUBWAVE_HOSTED = '1';
  }
});

test('every LLM leg field is managed unless it is listed as the operator\'s', async () => {
  for (const k of LLM_LEG_FIELDS) {
    assert.ok(HOSTED_LLM_KEYS.includes(k) !== (HOSTED_OPERATOR_LEG_FIELDS as readonly string[]).includes(k), k);
  }
  for (const k of ['baseUrl', 'apiKey', 'keys', 'fallback']) assert.ok(HOSTED_LLM_KEYS.includes(k), k);
  // discoverySteps is the Music selection page's, so a hosted save keeps it.
  const r = await post('/settings', { llm: { discoverySteps: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.managed, undefined);
  assert.equal(stored().llm.discoverySteps, 3);
});

test('the advertised mounts follow the ceiling the mixer files get', () => {
  const stream = { bitrate: 320, aacEnabled: true, aacBitrate: 256, opusEnabled: true, opusBitrate: 320, flacEnabled: true };
  process.env.SUBWAVE_MAX_BITRATE = '96';
  try {
    assert.deepEqual(advertisedMounts(stream), { opusEnabled: true, flacEnabled: false, aacEnabled: false });
  } finally {
    delete process.env.SUBWAVE_MAX_BITRATE;
  }
  assert.deepEqual(advertisedMounts(stream), { opusEnabled: true, flacEnabled: true, aacEnabled: true });
  assert.deepEqual(advertisedMounts(undefined), { opusEnabled: false, flacEnabled: false, aacEnabled: false });
});
