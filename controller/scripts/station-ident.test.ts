import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { normalizeForDisplay } from '../src/audio/speech-text.js';
import { createStationIdPicker } from '../src/broadcast/station-ident.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// The queue assertions run against the real queue under a temp STATE_DIR, so
// it must be set before anything that reads settings is imported.
const root = createTempDir(join(tmpdir(), 'subwave-station-ident-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { runStationId, createStationIdRunner } = await import('../src/broadcast/scheduler.js');
const { VERBATIM_META, withheldFromPrompts } = await import('../src/broadcast/prompt-memory.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

const persona = { id: 'p_ident', name: 'Ident', identMode: 'verbatim', identLines: ['First ident.', 'Second ident.'] };

test('random selection excludes the previous text for each persona', () => {
  const pick = createStationIdPicker(() => 0);
  assert.equal(pick(persona), 'First ident.');
  pick.commit(persona.id, 'First ident.');
  assert.equal(pick({ ...persona, id: 'p_other' }), 'First ident.');
  pick.commit('p_other', 'First ident.');
  assert.equal(pick(persona), 'Second ident.');
  pick.commit(persona.id, 'Second ident.');
  assert.equal(pick({ ...persona, id: 'p_other' }), 'Second ident.');
  pick.commit('p_other', 'Second ident.');
  assert.equal(pick(persona), 'First ident.');
});

test('random selection can reach every eligible line', () => {
  let random = 0.99;
  const pick = createStationIdPicker(() => random);
  const three = { ...persona, identLines: ['A', 'B', 'C'] };
  assert.equal(pick(three), 'C');
  pick.commit(three.id, 'C');
  assert.equal(pick(three), 'B');
  pick.commit(three.id, 'B');
  random = 0;
  assert.equal(pick(three), 'A');
});

test('one distinct line repeats, and whitespace and duplicate rows do not defeat rotation', () => {
  const pick = createStationIdPicker(() => 0);
  const one = { ...persona, identLines: [' ', ' Same line. ', 'Same line.'] };
  assert.equal(pick(one), 'Same line.');
  pick.commit(one.id, 'Same line.');
  assert.equal(pick(one), 'Same line.');
  pick.commit(one.id, 'Same line.');
  const two = { ...persona, identLines: ['Same line.', 'Same line.', 'Other line.'] };
  assert.equal(pick(two), 'Other line.');
  pick.commit(two.id, 'Other line.');
  assert.equal(pick(two), 'Same line.');
});

test('rotation dedupes the cleaned text the queue speaks', () => {
  const pick = createStationIdPicker(() => 0);
  const cleaned = { ...persona, identLines: ['Stay **with** us.', 'Stay with us.', '[music] Other line.'] };
  assert.equal(pick(cleaned), 'Stay **with** us.');
  pick.commit(cleaned.id, 'Stay **with** us.');
  assert.equal(pick(cleaned), '[music] Other line.');
  pick.commit(cleaned.id, '[music] Other line.');
  assert.equal(pick(cleaned), 'Stay **with** us.');
});

test('lines that clean to empty are ignored', () => {
  const pick = createStationIdPicker(() => { throw new Error('unexpected random selection'); });
  assert.equal(pick({ ...persona, identLines: ['[music]', '**'] }), null);
  assert.equal(pick({ ...persona, identLines: ['[music]', '**', 'Real ident.'] }), 'Real ident.');
});

test('absent, invalid and improvise modes leave the random sequence untouched', () => {
  const pick = createStationIdPicker(() => { throw new Error('unexpected random selection'); });
  assert.equal(pick(null), null);
  assert.equal(pick({ id: 'legacy' }), null);
  assert.equal(pick({ ...persona, identMode: 'improvise' }), null);
  assert.equal(pick({ ...persona, identMode: 'invalid' }), null);
  assert.equal(pick({ ...persona, identLines: [] }), null);
  assert.equal(pick({ ...persona, identLines: [' ', '\t'] }), null);
});

// Exercise the actual gate-free runner with its dependencies injected
// (createStationIdRunner). This seam needs neither a model provider nor
// TTS/native SQLite, and cannot air anything.
function fixture(speaker = persona, owner = speaker, delivery: Promise<void> | (() => void | Promise<void>) = Promise.resolve(), generation = Promise.resolve()) {
  let accepted = true;
  const context = { clock: { spokenDaypart: 'in the afternoon' } };
  const calls: any[] = [];
  const contextFetches = { count: 0 };
  const recap = 'Fixture recap';
  const openers = ['Recent opener'];
  const hostSpeech = { session: 'fixture' };
  const pickStationId = createStationIdPicker(() => 0);
  const run = createStationIdRunner(() => ({
    withTrace: (_trace, fn) => fn(),
    prepareEpisodeContext: async ctx => ctx,
    getFullContext: async () => { contextFetches.count++; return context; },
    settings: { pickOnAirSpeaker: () => speaker },
    session: { captureAutomaticHostSpeech: () => ({ persona: owner, hostSpeech }) },
    pickStationId,
    stationIdDaypartStamp: (daypart, allowed) => allowed ? daypart : null,
    speakClockAllowed: () => true,
    dj: { generateStationId: async args => { calls.push({ kind: 'model', args }); await generation; return 'Improvised fixture.'; } },
    queue: {
      getDjRecap: () => recap,
      getRecentOpeners: () => openers,
      announce: async (script, kind, opts) => {
        calls.push({ kind: 'immediate', script, segment: kind, opts });
        await (typeof delivery === 'function' ? delivery() : delivery);
        return { accepted };
      },
      announceAtNextTrack: async (script, kind, opts) => {
        calls.push({ kind: 'next-track', script, segment: kind, opts });
        await (typeof delivery === 'function' ? delivery() : delivery);
        return accepted;
      },
    },
  }) as any);
  return { run, calls, contextFetches, context, recap, openers, hostSpeech, accept: value => { accepted = value; }, setSpeaker: value => { speaker = value; } };
}

test('manual verbatim ident never calls generateStationId and keeps its voice and queue kind', async () => {
  const { run, calls } = fixture();
  assert.equal(await run(), 'First ident.');
  assert.deepEqual(calls, [{
    kind: 'immediate', script: 'First ident.', segment: 'station-id',
    opts: { persona, daypart: null, noClockClaim: true, hostSpeech: null, meta: { personaId: persona.id, personaName: persona.name, verbatim: true } },
  }]);
});

test('a verbatim ident never fetches the context an improvised one needs', async () => {
  for (const atNextTrack of [false, true]) {
    const { run, contextFetches } = fixture();
    assert.equal(await run({ atNextTrack }), 'First ident.');
    assert.equal(contextFetches.count, 0);
  }
  const improvised = fixture({ ...persona, identMode: 'improvise' });
  assert.equal(await improvised.run(), 'Improvised fixture.');
  assert.equal(improvised.contextFetches.count, 1);
});

test('automatic verbatim ident uses the captured speaker and next-track timing without a daypart claim', async () => {
  const owner = { ...persona, id: 'p_owner', identLines: ['Owner ident.'] };
  const { run, calls, hostSpeech } = fixture(persona, owner);
  assert.equal(await run({ automatic: true, atNextTrack: true }), 'Owner ident.');
  assert.deepEqual(calls, [{
    kind: 'next-track', script: 'Owner ident.', segment: 'station-id',
    opts: { persona: owner, daypart: null, noClockClaim: true, hostSpeech, meta: { personaId: owner.id, personaName: owner.name, verbatim: true } },
  }]);
});

for (const identLines of [[], [' ', '\t'], ['[music]', '**']]) {
  test(`empty or cleaned-empty verbatim lines fall back to the original generator (${JSON.stringify(identLines)})`, async () => {
    const { run, calls } = fixture({ ...persona, identLines });
    assert.equal(await run({ atNextTrack: true }), 'Improvised fixture.');
    assert.equal(calls[0].kind, 'model');
    assert.equal(calls[1].kind, 'next-track');
    assert.equal(calls[1].opts.daypart, 'in the afternoon');
  });
}

test('a legacy persona keeps the original generator arguments and daypart guard', async () => {
  const legacy = { id: 'p_legacy', name: 'Legacy' } as typeof persona;
  const { run, calls, context, recap, openers } = fixture(legacy);
  assert.equal(await run({ atNextTrack: true }), 'Improvised fixture.');
  assert.deepEqual(calls[0], { kind: 'model', args: { recap, context, recentOpeners: openers, persona: legacy } });
  assert.equal(calls[1].opts.daypart, 'in the afternoon');
});

test('the manual station-id route shares the gate-free runner', () => {
  const route = readFileSync(new URL('../src/routes/dj.ts', import.meta.url), 'utf8');
  assert.match(route, /'station-id': runStationId/);
});

for (const atNextTrack of [false, true]) {
  test(`a refused ident returns null and does not advance rotation (atNextTrack=${atNextTrack})`, async () => {
    const { run, accept } = fixture();
    assert.equal(await run({ atNextTrack }), 'First ident.');
    accept(false); // The queue catches a TTS failure and refuses the clip.
    assert.equal(await run({ atNextTrack }), null, 'a refused verbatim ident reports nothing aired');
    accept(true);
    assert.equal(await run({ atNextTrack }), 'Second ident.');
    assert.equal(await run({ atNextTrack }), 'First ident.');
  });
}

test('picks reserve one line per persona without advancing the last accepted line', () => {
  const pick = createStationIdPicker(() => 0);
  const three = { ...persona, identLines: ['A', 'B', 'C'] };
  assert.equal(pick(three), 'A');
  pick.commit(three.id, 'A');
  assert.equal(pick(three), 'B'); // Delivery fails; no commit.
  assert.equal(pick(three), 'C'); // Excludes accepted A and reserved B.
  assert.equal(pick(three), 'B'); // The reservation was overwritten, not accepted.
  pick.commit(three.id, 'B');
  assert.equal(pick(three), 'A');
});

test('an older acceptance preserves a newer in-flight reservation', () => {
  const pick = createStationIdPicker(() => 0);
  const three = { ...persona, identLines: ['A', 'B', 'C'] };
  assert.equal(pick(three), 'A');
  assert.equal(pick(three), 'B');
  pick.commit(three.id, 'A');
  assert.equal(pick(three), 'C');
});

for (const atNextTrack of [false, true]) {
  test(`a never-settling verbatim render cannot block another ident (atNextTrack=${atNextTrack})`, async () => {
    let deliveries = 0;
    const { run, calls } = fixture(persona, persona, () =>
      deliveries++ === 0 ? new Promise<void>(() => {}) : Promise.resolve());
    void run({ atNextTrack });
    await new Promise(resolve => setImmediate(resolve));
    const second = run({ atNextTrack });
    // Bound the assertion, without ever resolving the stalled first render.
    assert.equal(await Promise.race([
      second,
      new Promise(resolve => setImmediate(() => resolve('blocked'))),
    ]), 'Second ident.');
    assert.deepEqual(calls.map(call => call.script), ['First ident.', 'Second ident.']);
  });
}

for (const speaker of [
  { ...persona, identMode: 'improvise' },
  { ...persona, identMode: undefined },
  { ...persona, identLines: [] },
  { ...persona, identLines: ['[music]', '**'] },
]) {
  for (const stall of ['model', 'delivery']) {
    test(`${speaker.identMode ?? 'legacy'} (${JSON.stringify(speaker.identLines)}) starts concurrent idents during stalled ${stall}`, async () => {
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      const { run, calls } = fixture(speaker as typeof persona, speaker as typeof persona,
        stall === 'delivery' ? pending : Promise.resolve(),
        stall === 'model' ? pending : Promise.resolve());
      const first = run({ atNextTrack: true });
      const second = run({ atNextTrack: true });
      await new Promise(resolve => setImmediate(resolve));
      const started = calls.filter(call => call.kind === (stall === 'model' ? 'model' : 'next-track')).length;
      finish();
      await Promise.all([first, second]);
      assert.equal(started, 2);
    });
  }
}

for (const atNextTrack of [false, true]) {
  test(`a rejected verbatim ident reaches its caller without blocking another pick (atNextTrack=${atNextTrack})`, async () => {
    const failure = new Error('Queue failed');
    let deliveries = 0;
    const { run } = fixture(persona, persona, () => {
      if (deliveries++ === 0) throw failure;
    });
    const first = run({ atNextTrack });
    const second = run({ atNextTrack });
    await assert.rejects(first, failure);
    assert.equal(await second, 'Second ident.');
    assert.equal(await run({ atNextTrack }), 'First ident.');
  });
}

test('a stalled verbatim delivery does not block an improvised ident', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const { run, calls, setSpeaker } = fixture(persona, persona, pending);
  const first = run();
  await new Promise(resolve => setImmediate(resolve));
  setSpeaker({ ...persona, identMode: 'improvise' });
  const second = run();
  await new Promise(resolve => setImmediate(resolve));
  const models = calls.filter(call => call.kind === 'model').length;
  const deliveries = calls.filter(call => call.kind === 'immediate').length;
  finish();
  assert.deepEqual(await Promise.all([first, second]), ['First ident.', 'Improvised fixture.']);
  assert.equal(models, 1);
  assert.equal(deliveries, 2);
});

// ── The real queue ───────────────────────────────────────────────────────────
// TTS and the mixer are stubbed; everything between them is the real queue.

const IRIS = { ...settings.get().personas[0], id: 'p_iris', name: 'Iris', identMode: 'improvise', identLines: [] as string[] };
const realSpeak = (queue as any)._speak;
const realAirVoice = (queue as any)._airVoice;
const realFetch = globalThis.fetch;
const wav = join(root, 'ident.wav');
await writeSilentWav(wav, 100);
let spoken: string[] = [];

function context() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm', activeShow: null,
  } as any;
}

async function useIris(patch: Partial<typeof IRIS> = {}) {
  await settings.update({ personas: [{ ...IRIS, ...patch }], activePersonaId: IRIS.id } as never);
}

beforeEach(async () => {
  spoken = [];
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.djLog = [];
  queue._pendingVoice = null;
  (queue as any)._speak = async (text: string) => { spoken.push(text); return wav; };
  (queue as any)._airVoice = async () => ({ voiceId: 'voice-ident', clipMs: 100, aired: Promise.resolve(null) });
  // No context lookup may leave the machine.
  globalThis.fetch = (async () => { throw new Error('offline in tests'); }) as typeof fetch;
  await useIris();
  session.start(context());
});

after(async () => {
  (queue as any)._speak = realSpeak;
  (queue as any)._airVoice = realAirVoice;
  globalThis.fetch = realFetch;
  queue.senderBusy = false;
  // Let the session's debounced persist land before its directory goes.
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

async function turnFor(text: string) {
  for (let i = 0; i < 100; i++) {
    const turn = session.getSession()?.messages.find(m => m.text === text);
    if (turn) return turn;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}

test('a verbatim ident that is a listed stand-in still airs, and no prompt reads it back', async () => {
  await useIris({ identMode: 'verbatim', identLines: ['TBD'] });
  assert.equal(await runStationId(), 'TBD');
  assert.deepEqual(spoken, ['TBD'], 'operator words skip the stand-in gate');
  const turn = await turnFor('TBD');
  assert.ok(turn, 'the ident reaches the session once aired');
  assert.equal(turn!.meta.verbatim, true);
  assert.equal(withheldFromPrompts(turn), true);
  assert.equal(queue.getDjRecap(), null, 'no "Already said on air recently" entry');
  assert.deepEqual(queue.getRecentOpeners(), [], 'no "Recent opening words" entry');
});

test('the same stand-in from the model is still dropped', async () => {
  const outcome = await queue.announce('TBD', 'station-id', { persona: IRIS as never });
  assert.equal(outcome.accepted, false);
  assert.deepEqual(spoken, []);
});

test('a deferred verbatim ident skips the stand-in gate and holds with no clock claim', async () => {
  await useIris({ identMode: 'verbatim', identLines: ['TBD'] });
  assert.equal(await runStationId({ atNextTrack: true }), 'TBD');
  assert.deepEqual(spoken, ['TBD']);
  assert.equal(queue._pendingVoice!.kind, 'station-id');
  assert.equal(queue._pendingVoice!.daypart, null);
  assert.equal(queue._pendingVoice!.clips[0].meta.verbatim, true);
});

test('noClockClaim keeps a null stamp; an offered stamp survives without it', async () => {
  assert.equal(await queue.announceAtNextTrack('First ident.', 'station-id', { persona: IRIS as never, daypart: 'in the morning', noClockClaim: true }), true);
  assert.equal(queue._pendingVoice!.daypart, null);
  assert.equal(await queue.announceAtNextTrack('Improvised ident.', 'station-id', { persona: IRIS as never, daypart: 'in the morning' }), true);
  assert.equal(queue._pendingVoice!.daypart, 'in the morning');
});

test('a refused verbatim ident returns null through the real queue', async () => {
  await useIris({ identMode: 'verbatim', identLines: ['First ident.'] });
  (queue as any)._speak = async () => { throw new Error('TTS failed'); };
  assert.equal(await runStationId({ atNextTrack: true }), null);
  queue._pendingVoice = { pauseId: 'committed', pauseArmedAt: Date.now() } as never;
  (queue as any)._speak = async () => wav;
  assert.equal(await runStationId({ atNextTrack: true }), null, 'a declined slot is a refusal too');
  queue._pendingVoice = null;
  assert.equal(await runStationId({ atNextTrack: true }), 'First ident.');
});

// Chosen on purpose: a verbatim ident is cleaned like a raw /dj/say, which also
// carries meta.verbatim and has always had the on-air speaker's label removed.
for (const method of ['announce', 'announceAtNextTrack'] as const) {
  test(`${method} strips the speaker label from a verbatim line, as from a raw say`, async () => {
    await queue[method]('Iris: This is SUB/WAVE.', 'station-id', { persona: IRIS as never, meta: { ...VERBATIM_META } });
    assert.deepEqual(spoken, ['This is SUB/WAVE.']);
  });

  test(`${method} cleans raw picker text exactly once for accepted rotation`, async () => {
    const encoded = { ...IRIS, identMode: 'verbatim', identLines: [' Stay &amp;amp; listen. ', 'Stay &amp; listen.', 'Other ident.'] };
    const pick = createStationIdPicker(() => 0);
    for (let i = 0; i < 6; i++) {
      queue._pendingVoice = null;
      const raw = pick(encoded)!;
      if (i === 0) assert.equal(raw, 'Stay &amp;amp; listen.');
      const outcome = await queue[method](raw, 'station-id', { persona: encoded as never, meta: { ...VERBATIM_META }, noClockClaim: true });
      assert.equal(typeof outcome === 'boolean' ? outcome : outcome.accepted, true);
      assert.equal(spoken[i], normalizeForDisplay(raw));
      if (i > 0) assert.notEqual(spoken[i], spoken[i - 1]);
      pick.commit(encoded.id, raw);
    }
  });
}

