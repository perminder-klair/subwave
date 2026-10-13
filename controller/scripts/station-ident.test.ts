import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { normalizeForDisplay, stripSpeakerLabel } from '../src/audio/speech-text.js';
import { createStationIdPicker } from '../src/broadcast/station-ident.js';

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

// Exercise the actual gate-free runner with its imports injected. This seam
// needs neither a model provider nor TTS/native SQLite, and cannot air anything.
const scheduler = readFileSync(new URL('../src/broadcast/scheduler.ts', import.meta.url), 'utf8');
const runnerSource = scheduler.match(/export (async function runStationId\([\s\S]*?)\n\/\/ TALK TICK/)?.[1];
assert.ok(runnerSource, 'station-ident runner must exist');

function fixture(speaker = persona, owner = speaker, delivery: Promise<void> | (() => void | Promise<void>) = Promise.resolve(), generation = Promise.resolve()) {
  let accepted = true;
  const context = { clock: { spokenDaypart: 'in the afternoon' } };
  const calls: any[] = [];
  const recap = 'Fixture recap';
  const openers = ['Recent opener'];
  const hostSpeech = { session: 'fixture' };
  const run = new Function('withTrace', 'prepareEpisodeContext', 'getFullContext', 'settings', 'session', 'pickStationId', 'stationIdDaypartStamp', 'speakClockAllowed', 'dj', 'queue', ts.transpileModule(`return (${runnerSource});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
    (_trace, fn) => fn(),
    async ctx => ctx,
    async () => context,
    { pickOnAirSpeaker: () => speaker },
    { captureAutomaticHostSpeech: () => ({ persona: owner, hostSpeech }) },
    createStationIdPicker(() => 0),
    (daypart, allowed) => allowed ? daypart : null,
    () => true,
    { generateStationId: async args => { calls.push({ kind: 'model', args }); await generation; return 'Improvised fixture.'; } },
    {
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
  );
  return { run, calls, context, recap, openers, hostSpeech, accept: value => { accepted = value; }, setSpeaker: value => { speaker = value; } };
}

test('manual verbatim ident never calls generateStationId and keeps its voice and queue kind', async () => {
  const { run, calls } = fixture();
  assert.equal(await run(), 'First ident.');
  assert.deepEqual(calls, [{
    kind: 'immediate', script: 'First ident.', segment: 'station-id',
    opts: { persona, daypart: null, verbatim: true, hostSpeech: null, meta: { personaId: persona.id, personaName: persona.name } },
  }]);
});

test('automatic verbatim ident uses the captured speaker and next-track timing without a daypart claim', async () => {
  const owner = { ...persona, id: 'p_owner', identLines: ['Owner ident.'] };
  const { run, calls, hostSpeech } = fixture(persona, owner);
  assert.equal(await run({ automatic: true, atNextTrack: true }), 'Owner ident.');
  assert.deepEqual(calls, [{
    kind: 'next-track', script: 'Owner ident.', segment: 'station-id',
    opts: { persona: owner, daypart: null, verbatim: true, hostSpeech, meta: { personaId: owner.id, personaName: owner.name } },
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

// Use the real deferred queue methods too: they must preserve an explicit
// clockless stamp rather than filling it from the live clock after rendering.
const queueSource = readFileSync(new URL('../src/broadcast/queue.ts', import.meta.url), 'utf8');
function queueMethod(name: string) {
  const method = queueSource.match(new RegExp(`^  (?:async )?${name}\\([\\s\\S]*?^  }`, 'm'))?.[0];
  assert.ok(method, `queue.${name} must exist`);
  return method;
}
const deferredMethods = ts.transpileModule(`return {
  ${queueMethod('announceAtNextTrack')},
  ${queueMethod('holdForNextTrack')}
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function deferredQueue() {
  const clock = { spokenDaypart: 'in the afternoon' };
  const methods = new Function('settings', 'normalizeForDisplay', 'stripSpeakerLabel', 'session', 'suppressScheduledSpeechDuringHandoff', 'stationIdDaypartStamp', 'getClockContext', 'speakClockAllowed', 'pauseTalkArmExpired', deferredMethods)(
    { getEffectivePersona: () => persona },
    text => text,
    text => text,
    { isHostSpeechCurrent: () => true, handoffInProgress: () => false },
    () => false,
    (daypart, allowed) => allowed ? daypart : null,
    () => clock,
    () => true,
    () => false,
  );
  return { ...methods, clock, _pendingVoice: null, _speak: async () => 'fixture.wav', log: () => {} };
}

test('the deferred queue preserves a verbatim ident\'s explicit null stamp after TTS', async () => {
  const queue = deferredQueue();
  await queue.announceAtNextTrack('First ident.', 'station-id', { persona, daypart: null, verbatim: true });
  assert.equal(queue._pendingVoice.daypart, null);
  assert.equal(queue._pendingVoice.clips[0].persona, persona);
  assert.equal(queue._pendingVoice.kind, 'station-id');
});

test('an improvised ident with a null offered stamp gets the live stamp after TTS', async () => {
  const queue = deferredQueue();
  queue._speak = async () => { queue.clock.spokenDaypart = 'in the evening'; return 'fixture.wav'; };
  await queue.announceAtNextTrack('Improvised ident.', 'station-id', { daypart: null, verbatim: false });
  assert.equal(queue._pendingVoice.daypart, 'in the evening');
});

test('the deferred queue still stamps an omitted daypart and preserves the model\'s explicit stamp', async () => {
  const queue = deferredQueue();
  await queue.announceAtNextTrack('Ordinary announcement.');
  assert.equal(queue._pendingVoice.daypart, 'in the afternoon');
  await queue.announceAtNextTrack('Improvised ident.', 'station-id', { daypart: 'in the morning' });
  assert.equal(queue._pendingVoice.daypart, 'in the morning');
});

for (const atNextTrack of [false, true]) {
  test(`a refused ident does not advance rotation (atNextTrack=${atNextTrack})`, async () => {
    const { run, accept } = fixture();
    assert.equal(await run({ atNextTrack }), 'First ident.');
    accept(false); // The queue catches a TTS failure and refuses the clip.
    assert.equal(await run({ atNextTrack }), 'Second ident.');
    accept(true);
    assert.equal(await run({ atNextTrack }), 'Second ident.');
    assert.equal(await run({ atNextTrack }), 'First ident.');
  });
}

// Execute both real queue methods with the real text cleanup. Stop at TTS,
// before audio or filesystem work, and capture exactly what it received.
const announcementMethods = ts.transpileModule(`return {
  ${queueMethod('announce')},
  ${queueMethod('announceAtNextTrack')}
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

for (const method of ['announce', 'announceAtNextTrack']) {
  for (const verbatim of [true, false]) {
    test(`${method} ${verbatim ? 'preserves authored' : 'strips model'} persona labels at TTS`, async () => {
      const iris = { ...persona, name: 'Iris', identMode: verbatim ? 'verbatim' : 'improvise' };
      const spoken: string[] = [];
      const methods = new Function('settings', 'normalizeForDisplay', 'stripSpeakerLabel', 'session', 'suppressScheduledSpeechDuringHandoff', announcementMethods)(
        { getEffectivePersona: () => iris },
        normalizeForDisplay,
        stripSpeakerLabel,
        { handoffInProgress: () => false },
        () => false,
      );
      const queue = { ...methods, log: () => {}, _speak: async text => {
        spoken.push(text);
        throw new Error('stop at TTS');
      } };
      await queue[method]('Iris: This is SUB/WAVE.', 'station-id', { persona: iris, verbatim });
      assert.deepEqual(spoken, [verbatim ? 'Iris: This is SUB/WAVE.' : 'This is SUB/WAVE.']);
    });
  }
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

test('the deferred queue reports TTS failure and a declined slot as refused', async () => {
  const queue = deferredQueue();
  queue._speak = async () => { throw new Error('TTS failed'); };
  assert.equal(await queue.announceAtNextTrack('Failed ident.', 'station-id'), false);
  queue._speak = async () => 'fixture.wav';
  queue._pendingVoice = { pauseId: 'committed', pauseArmedAt: Date.now() };
  assert.equal(await queue.announceAtNextTrack('Declined ident.', 'station-id'), false);
  queue._pendingVoice = null;
  assert.equal(await queue.announceAtNextTrack('Accepted ident.', 'station-id'), true);
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

for (const method of ['announce', 'announceAtNextTrack']) {
  test(`${method} cleans raw picker text exactly once for accepted rotation`, async () => {
    const encoded = { ...persona, identLines: [' Stay &amp;amp; listen. ', 'Stay &amp; listen.', 'Other ident.'] };
    const pick = createStationIdPicker(() => 0);
    const spoken: string[] = [];
    const methods = new Function('settings', 'normalizeForDisplay', 'stripSpeakerLabel', 'session', 'suppressScheduledSpeechDuringHandoff', 'wantsPauseTalk', 'speechDurationMs', 'resolveTalkPlacement', 'currentTalkAir', announcementMethods)(
      { getEffectivePersona: () => encoded, resolveActiveShow: () => null, get: () => ({}) },
      normalizeForDisplay,
      stripSpeakerLabel,
      { handoffInProgress: () => false },
      () => false,
      () => false,
      () => 1000,
      () => 'next-track',
      () => 'next-track',
    );
    const queue = {
      ...methods,
      log: () => {},
      _speak: async text => { spoken.push(text); return 'fixture.wav'; },
      holdForNextTrack: () => true,
    };
    for (let i = 0; i < 6; i++) {
      const raw = pick(encoded)!;
      if (i === 0) assert.equal(raw, 'Stay &amp;amp; listen.');
      const outcome = await queue[method](raw, 'station-id', { persona: encoded, verbatim: true });
      assert.equal(method === 'announce' ? outcome.accepted : outcome, true);
      assert.equal(spoken[i], normalizeForDisplay(raw));
      if (i > 0) assert.notEqual(spoken[i], spoken[i - 1]);
      pick.commit(encoded.id, raw);
    }
  });
}
