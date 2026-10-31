// A persona's own rescue voice (#2029). When a persona-voiced render throws
// mid-render, the rescue chain must speak that persona's `fallbackVoice` before
// the station-wide slot, so two co-hosts rescued at once do not both air in the
// one station voice (Emma's link aired in a male voice close to Tom's).
//
// Driven through the real dispatcher: Remote's /health answers ok, its /speak
// aborts (the reporter's dead RunPod worker), and Gemini — the station default
// engine here — records the voice each rescue asked for.
// Run: npm test -- tts-persona-rescue

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-persona-rescue-'));
process.env.STATE_DIR = root;
process.env.PIPER_OUT = join(root, 'voice');
process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';

const settings = await import('../src/settings.js');
const remoteTts = await import('../src/audio/remoteTts.js');
const tts = await import('../src/audio/tts.js');
const { ttsCalls } = await import('../src/stats.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

const wav = join(root, 'provider.wav');
await writeSilentWav(wav, 500);
const audio = readFileSync(wav).toString('base64');

// Loose patch type: these fixtures add a field the settings type predates.
const update = settings.update as unknown as (patch: Record<string, unknown>) => Promise<unknown>;
type Row = Record<string, unknown>;
const template = settings.get().personas[0];
const tom = {
  ...template, id: 'p_tom', name: 'Tom', djMode: true,
  tts: { ...template.tts, engine: 'remote', voice: 'tom-clone', gainDb: 0 },
  fallbackVoice: null,
};
const emma = {
  ...template, id: 'p_emma', name: 'Emma', djMode: true,
  tts: { ...template.tts, engine: 'remote', voice: 'emma-clone', gainDb: 0 },
  fallbackVoice: { engine: 'gemini', cloudProvider: 'openai', voice: 'Kore' },
};

await update({
  personas: [tom, emma],
  activePersonaId: tom.id,
  tts: {
    defaultEngine: 'gemini',
    gemini: { voice: 'Charon' },
    remote: { url: 'https://remote.test' },
  },
});

// Gemini voice per request, in order.
let geminiVoices: string[] = [];
function mockNetwork(t: { mock: { method: typeof import('node:test').mock.method } }) {
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://remote.test/health') return Response.json({ ok: true });
    if (url.startsWith('https://remote.test/')) {
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    const body = JSON.parse(String(init?.body || '{}'));
    geminiVoices.push(body.generation_config?.speech_config?.[0]?.voice);
    return Response.json({ output_audio: { data: audio } });
  });
}

const savedEmma = () => (settings.get().personas as Row[]).find((p) => p.id === 'p_emma');
const savedTom = () => (settings.get().personas as Row[]).find((p) => p.id === 'p_tom');

test('the saved persona keeps its rescue voice', () => {
  assert.deepEqual(savedEmma()?.fallbackVoice, { engine: 'gemini', cloudProvider: 'openai', voice: 'Kore' });
  assert.equal(savedTom()?.fallbackVoice, null);
});

test('a persona rescued mid-render speaks in its own rescue voice', async (t) => {
  mockNetwork(t);
  geminiVoices = [];
  await remoteTts.refresh();
  assert.equal(remoteTts.isAvailable(), true, 'remote passes pre-flight; it fails mid-render');

  const out = await tts.speak("That's Movin' To The Sun. Tom, your turn.", { kind: 'link', persona: savedEmma() });
  assert.equal(typeof out, 'string');
  assert.deepEqual(geminiVoices, ['Kore'], "Emma's line airs in Emma's rescue voice, not the station's");
  const call = ttsCalls[0];
  assert.equal(call.engine, 'gemini');
  assert.equal(call.fellBack, true);
  assert.equal(call.ok, true);
  assert.equal(call.persona, 'Emma');
});

test('a persona with no rescue voice still falls to the station slot', async (t) => {
  mockNetwork(t);
  geminiVoices = [];
  await remoteTts.refresh();
  await tts.speak('Back to the music.', { kind: 'link', persona: savedTom() });
  assert.deepEqual(geminiVoices, ['Charon']);
});

test('a global kind never takes the persona rescue voice', async (t) => {
  mockNetwork(t);
  geminiVoices = [];
  await update({ tts: { defaultEngine: 'remote' } });
  try {
    await remoteTts.refresh();
    // Piper/Kokoro may be absent in CI; only which voices Gemini was asked for matters.
    await tts.speak('Station ident.', { kind: 'default', persona: savedEmma() }).catch(() => {});
    await tts.speak('Station ident.', { kind: 'jingle', persona: savedEmma() }).catch(() => {});
  } finally {
    await update({ tts: { defaultEngine: 'gemini' } });
  }
  // Remote fails, the hardcoded rungs are piper/kokoro (no Gemini default), so
  // Gemini must not be reached at all through Emma's rescue slot.
  assert.deepEqual(geminiVoices, [], 'jingle/default never use a persona rescue voice');
});

test('pre-flight reroute takes the persona rescue too, and gain/pace agree with it', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://remote.test/')) return new Response('down', { status: 503 });
    const body = JSON.parse(String(init?.body || '{}'));
    geminiVoices.push(body.generation_config?.speech_config?.[0]?.voice);
    return Response.json({ output_audio: { data: audio } });
  });
  geminiVoices = [];
  await update({ tts: { gainDb: { gemini: -3, piper: 4 }, speed: { gemini: 1.2, piper: 1 } } });
  try {
    await remoteTts.refresh();
    assert.equal(remoteTts.isAvailable(), false);
    // Emma's rescue is gemini; the station default is gemini too, so pin the
    // agreement with an engine-specific trim on a different engine.
    await update({ personas: [tom, { ...emma, fallbackVoice: { engine: 'piper', cloudProvider: 'openai', voice: '' } }] });
    assert.equal(tts.voiceGainDb('link', savedEmma()), 4, 'gain reads the engine that will speak');
    assert.equal(tts.voiceGainDb('link', savedTom()), -3);
    assert.equal(tts.voiceGainDb('default', savedEmma()), -3, 'global kinds ignore the persona rescue');
    await update({ personas: [tom, emma] });
    await tts.speak('Pre-flight rescue.', { kind: 'link', persona: savedEmma() });
    assert.deepEqual(geminiVoices, ['Kore']);
    assert.equal(ttsCalls[0].fellBack, true);
  } finally {
    await update({ tts: { gainDb: { gemini: 0, piper: 0 }, speed: { gemini: 1, piper: 1 } }, personas: [tom, emma] });
  }
});

test('describeRouting reports the effective persona rescue voice', async () => {
  await update({ activePersonaId: emma.id });
  try {
    const routing = tts.describeRouting();
    assert.deepEqual(routing.personaFallback, { engine: 'gemini', voice: 'Kore', provider: null, usable: true });
  } finally {
    await update({ activePersonaId: tom.id });
  }
  assert.equal(tts.describeRouting().personaFallback, null);
});

test('every resolveEngine caller passes the gated persona rescue', () => {
  const src = readFileSync(new URL('../src/audio/tts.ts', import.meta.url), 'utf8');
  const calls = src.match(/resolveEngine\(personaTts[,)][^\n]*/g) || [];
  assert.equal(calls.length, 4, `four persona resolveEngine callers: ${calls}`);
  for (const c of calls) assert.match(c, /^resolveEngine\(personaTts, (rescue|personaRescue\(kind, persona\))\)/, c);
  assert.match(src, /function personaRescue\(kind: string, persona\?: any\): RescueSlot \| null \{\s*if \(GLOBAL_VOICE_KINDS\.has\(kind\)\) return null;/);
  // The one gated helper is the only place the slot is built.
  assert.equal((src.match(/personaRescueSlot\(/g) || []).length, 1, 'personaRescueSlot is called only inside personaRescue()');
});
