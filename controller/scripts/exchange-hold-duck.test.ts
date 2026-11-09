// `djBehaviour.holdDuckBetweenSpeakers` decides how a multi-voice exchange is
// delivered. On: the whole conversation goes to the mixer as one batch, so its
// voice queue never drains and the music duck stays down for every speaker —
// no fade between presenters. Off, the default: the established per-line
// delivery, where each line is written only after the previous one's playback
// hold and the music lifts between speakers.
//
// Run: npm test -- exchange-hold-duck

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-exchange-hold-duck-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

const wav = join(root, 'line.wav');
await writeSilentWav(wav, 100);
const template = settings.get().personas[0];
const host = { ...template, id: 'p_host', name: 'Host' };
const guest = { ...template, id: 'p_guest', name: 'Guest' };
const exchange = [
  { persona: host as never, text: 'The host opens.' },
  { persona: guest as never, text: 'The guest answers.' },
];

const realSpeak = (queue as any)._speak;
const realAirVoice = (queue as any)._airVoice;
const realAirExchange = (queue as any)._airExchange;

beforeEach(async () => {
  (queue as any)._speak = async () => wav;
  (queue as any)._airVoice = realAirVoice;
  (queue as any)._airExchange = realAirExchange;
  queue._pendingVoice = null;
  session.start({
    at: new Date().toISOString(), time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm', activeShow: null,
  } as never);
});

after(async () => {
  (queue as any)._speak = realSpeak;
  (queue as any)._airVoice = realAirVoice;
  (queue as any)._airExchange = realAirExchange;
  queue.dropPendingVoice('test cleanup');
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

/** Air `exchange` with the option at `holdDuck`, counting each delivery path. */
async function deliver(holdDuck: boolean) {
  await settings.update({ djBehaviour: { holdDuckBetweenSpeakers: holdDuck } } as never);
  const calls = { batch: 0, perLine: 0 };
  (queue as any)._airExchange = async (_file: string, clips: { onQueued?: (q: unknown) => void }[]) => {
    calls.batch++;
    return clips.map((clip, index) => {
      clip.onQueued?.({ voiceId: `b${index}`, clipMs: 100, estimatedAirInMs: 0 });
      return { voiceId: `b${index}`, clipMs: 100, aired: Promise.resolve(null) };
    });
  };
  (queue as any)._airVoice = async (
    _file: string, _wav: string, _text: string, _gain: number,
    opts?: { onQueued?: (q: unknown) => void },
  ) => {
    calls.perLine++;
    opts?.onQueued?.({ voiceId: `v${calls.perLine}`, clipMs: 100, estimatedAirInMs: 0 });
    return { voiceId: `v${calls.perLine}`, clipMs: 100, aired: Promise.resolve(null) };
  };
  const aired = await queue.announceExchange(exchange);
  return { aired, calls };
}

test('the option is off on an upgrade', () => {
  assert.equal(settings.get().djBehaviour.holdDuckBetweenSpeakers, false);
});

test('off hands the exchange over one line at a time', async () => {
  const { aired, calls } = await deliver(false);
  assert.equal(aired, true);
  assert.deepEqual(calls, { batch: 0, perLine: 2 }, 'each line gets its own handoff and its own lead-in');
});

test('on hands the whole exchange over as one batch', async () => {
  const { aired, calls } = await deliver(true);
  assert.equal(aired, true);
  assert.deepEqual(calls, { batch: 1, perLine: 0 }, 'the voice queue never drains between speakers');
});
