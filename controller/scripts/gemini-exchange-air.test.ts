// The real queue and dispatcher must keep a Gemini exchange's per-line identity.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-gemini-exchange-'));
process.env.STATE_DIR = root;
process.env.PIPER_OUT = join(root, 'voice');
process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');
const { awaitVoiceAir, pollVoiceMarker, resetVoiceMarkers } = await import('../src/broadcast/queue/voice-marker.js');
const { withTalkAir } = await import('../src/broadcast/talk-air.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

const wav = join(root, 'provider.wav');
await writeSilentWav(wav, 30_000);
const data = readFileSync(wav).toString('base64');
const template = settings.get().personas[0];
const outgoing = { ...template, id: 'p_outgoing', name: 'Outgoing', tts: { ...template.tts, engine: 'gemini', voice: 'Puck', gainDb: 0 } };
const incoming = { ...template, id: 'p_incoming', name: 'Incoming', tts: { ...template.tts, engine: 'gemini', voice: 'Kore', gainDb: -10 } };
const lines = [{ persona: outgoing, text: 'Outgoing: Goodbye.' }, { persona: incoming, text: 'Incoming: Hello.' }];
after(async () => {
  resetVoiceMarkers();
  queue.dropPendingVoice('test cleanup');
  await new Promise(resolve => setTimeout(resolve, 1100));
  rmSync(root, { recursive: true, force: true });
});

async function setup() {
  await settings.update({ personas: [outgoing, incoming], activePersonaId: outgoing.id,
    tts: { defaultEngine: 'gemini', speed: { gemini: 1 }, gainDb: { gemini: 0 } } });
  session.start({ at: new Date().toISOString(), time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm', activeShow: null } as any);
  resetVoiceMarkers();
}

test('two Gemini speakers retain gain and attribution, and only the final marker settles a handoff', async t => {
  await setup();
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ output_audio: { data } });
  });
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId: 'old', startedAt: Date.now() / 1000 }));
  const deliveries: { path: string; text: string; gain: number; voiceId: string }[] = [];
  const completed: Promise<boolean>[] = [];
  const realOnSpoken = queue.onSpoken.bind(queue);
  t.mock.method(queue, 'onSpoken', (...args: Parameters<typeof queue.onSpoken>) => {
    const result = realOnSpoken(...args);
    completed.push(result);
    return result;
  });
  t.mock.method(queue as any, '_airVoice', async (_target: string, path: string, text: string, gain: number) => {
    const voiceId = `line-${deliveries.length}`;
    deliveries.push({ path, text, gain, voiceId });
    return { voiceId, clipMs: 30_000, aired: awaitVoiceAir(voiceId) };
  });
  assert.equal(await queue.announceExchange(lines, 'handoff'), true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.input[0].content.map((c: any) => c.text)), [['Goodbye.'], ['Hello.']]);
  assert.deepEqual(requests.map(r => r.generation_config.speech_config[0].voice), ['Puck', 'Kore']);
  assert.deepEqual(deliveries.map(d => d.gain), [0, -10]);
  assert.equal(new Set(deliveries.map(d => d.path)).size, 2);
  assert.equal(session.getSession()?.handoffAired, undefined);
  const at = Date.now();
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId: deliveries[0].voiceId, startedAt: at / 1000 }));
  pollVoiceMarker();
  assert.equal(await completed[0], true);
  assert.equal(session.getSession()?.handoffAired, undefined, 'outgoing start cannot settle the incoming greeting');
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId: deliveries[1].voiceId, startedAt: (at + 30_000) / 1000 }));
  pollVoiceMarker();
  assert.equal(await completed[1], true);
  assert.equal(session.getSession()?.handoffAired, true);
  const turns = session.getSession()!.messages.filter(m => m.role === 'segment');
  assert.deepEqual(turns.map(m => m.meta?.personaId), [outgoing.id, incoming.id]);
  assert.deepEqual(turns.map(m => m.text), ['Goodbye.', 'Hello.']);
  assert.deepEqual(turns.map(m => m.meta?.airedAt), [new Date(at).toISOString(), new Date(at + 30_000).toISOString()]);
  // The clip length rides on the turn so a player knows when the words end (#1848).
  assert.deepEqual(turns.map(m => m.meta?.durationMs), [30_000, 30_000]);
});

test('a deferred Gemini handoff holds individual speakers and final-line settlement', async t => {
  await setup();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ output_audio: { data } }));
  assert.equal(await withTalkAir('next-track', () => queue.announceExchange(lines, 'handoff')), true);
  const clips = queue._pendingVoice!.clips;
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map(c => c.persona?.id), [outgoing.id, incoming.id]);
  assert.deepEqual(clips.map(c => c.settlesHandoff), [false, true]);
});

test('failure on the second render publishes no partial exchange', async t => {
  await setup();
  let renders = 0;
  t.mock.method(queue as any, '_speak', async () => {
    if (++renders === 2) throw new Error('render failed');
    return wav;
  });
  const air = t.mock.method(queue as any, '_airVoice', async () => { throw new Error('must not publish'); });
  assert.equal(await queue.announceExchange(lines), false);
  assert.equal(air.mock.callCount(), 0);
});
