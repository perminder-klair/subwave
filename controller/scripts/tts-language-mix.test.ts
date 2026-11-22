// A multilingual persona's mix (`alsoSpeaks`) through the real dispatcher.
// The primary cloud render carries the mix (the line keeps its kana and OpenAI
// is told it mixes languages); a rescue voice never does: its text is scrubbed
// by the primary language alone and its delivery hint is the one-language one,
// so ElevenLabs keeps its language code. Both a mid-render rescue and a
// pre-flight reroute are rescues.
//
// Same harness as scripts/tts-persona-rescue.test.ts: Remote's /health answers
// (or not), its /speak aborts, and the cloud providers record each request.
// Run: npm test -- tts-language-mix

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-language-mix-'));
process.env.STATE_DIR = root;
process.env.PIPER_OUT = join(root, 'voice');
process.env.OPENAI_API_KEY = 'test-openai';
process.env.ELEVENLABS_API_KEY = 'test-elevenlabs';

const settings = await import('../src/settings.js');
const remoteTts = await import('../src/audio/remoteTts.js');
const tts = await import('../src/audio/tts.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

const wav = join(root, 'provider.wav');
await writeSilentWav(wav, 500);
const wavBytes = readFileSync(wav);

// Loose patch type: these fixtures add fields the settings type predates.
const update = settings.update as unknown as (patch: Record<string, unknown>) => Promise<unknown>;
type Row = Record<string, unknown>;
const template = settings.get().personas[0];
const LINE = 'Next up, ウルフルズ — やばい tune.';
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

await update({
  tts: {
    defaultEngine: 'piper',
    remote: { url: 'https://remote.test' },
    cloud: { enabled: true, provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
  },
});

type Sent = { provider: 'openai' | 'elevenlabs'; body: Record<string, unknown> };
let sent: Sent[] = [];
function mockNetwork(t: { mock: { method: typeof import('node:test').mock.method } }, { remoteUp }: { remoteUp: boolean }) {
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://remote.test/health') {
      return remoteUp ? Response.json({ ok: true }) : new Response('down', { status: 503 });
    }
    if (url.startsWith('https://remote.test/')) throw new DOMException('This operation was aborted', 'AbortError');
    const body = JSON.parse(String(init?.body || '{}'));
    if (url.includes('api.openai.com')) {
      sent.push({ provider: 'openai', body });
      return new Response(wavBytes, { headers: { 'content-type': 'audio/wav' } });
    }
    if (url.includes('elevenlabs.io')) {
      sent.push({ provider: 'elevenlabs', body });
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { headers: { 'content-type': 'audio/mpeg' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const nova = (over: Row) => ({
  ...template, id: 'p_nova', name: 'Nova', djMode: true, language: 'English', alsoSpeaks: 'Japanese', ...over,
});
async function speakAs(persona: Row) {
  await update({ personas: [persona], activePersonaId: 'p_nova' });
  const saved = (settings.get().personas as Row[]).find((p) => p.id === 'p_nova');
  // A rescue that ends on a local engine may be absent in CI; only the cloud
  // requests matter here.
  await tts.speak(LINE, { kind: 'link', persona: saved }).catch(() => {});
}

test('the primary cloud render carries the mix', async (t) => {
  mockNetwork(t, { remoteUp: true });
  sent = [];
  await speakAs(nova({ tts: { ...template.tts, engine: 'cloud', cloudProvider: 'openai', voice: 'alloy', gainDb: 0 }, fallbackVoice: null }));
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].body.input), KANA, 'the mixed-in script reaches the voice it was written for');
  assert.match(String(sent[0].body.instructions), /mixes English, Japanese/);
});

test('a mid-render rescue gets no mix: scrubbed text, one-language hint', async (t) => {
  mockNetwork(t, { remoteUp: true });
  sent = [];
  await remoteTts.refresh();
  assert.equal(remoteTts.isAvailable(), true);
  await speakAs(nova({
    tts: { ...template.tts, engine: 'remote', voice: 'nova-clone', gainDb: 0 },
    fallbackVoice: { engine: 'cloud', cloudProvider: 'openai', voice: 'nova' },
  }));
  assert.equal(sent.length, 1, 'the persona rescue voice spoke');
  assert.doesNotMatch(String(sent[0].body.input), KANA, 'the rescue is scrubbed by the primary language');
  assert.doesNotMatch(String(sent[0].body.instructions || ''), /mixes/);
  assert.match(String(sent[0].body.instructions), /Speak entirely in English/);
});

test('a pre-flight reroute is a rescue too, and ElevenLabs keeps its language code', async (t) => {
  mockNetwork(t, { remoteUp: false });
  sent = [];
  await remoteTts.refresh();
  assert.equal(remoteTts.isAvailable(), false);
  await speakAs(nova({
    tts: { ...template.tts, engine: 'remote', voice: 'nova-clone', gainDb: 0 },
    fallbackVoice: { engine: 'cloud', cloudProvider: 'elevenlabs', voice: 'EXAVITQu4vr4xnSDxMaL' },
  }));
  assert.equal(sent.length, 1, 'the persona rescue voice spoke');
  assert.equal(sent[0].provider, 'elevenlabs');
  assert.doesNotMatch(String(sent[0].body.text), KANA);
  assert.equal(sent[0].body.language_code, 'en', 'no mix forwarded, so the one-language code stays');
});
