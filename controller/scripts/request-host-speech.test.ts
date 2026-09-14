// Listener-request intros are generated asynchronously but air later. Pin the
// writer and host epoch before model work so a host edit drops only the words,
// never the listener provenance or requested music.

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-request-host-speech-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { runRequest } = await import('../src/broadcast/dj-agent.js');
const { requestSystem } = await import('../src/broadcast/dj-agent/schemas.js');
const { generateQueuedRequestIntro } = await import('../src/broadcast/request-intro.js');

const template = settings.get().personas[0];
const A = { ...template, id: 'p_a', name: 'Host A' };
const B = { ...template, id: 'p_b', name: 'Host B' };
const SHOW = 's_request';

function week() {
  const out: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) out[day] = Array(24).fill(SHOW);
  return out;
}
function show(personaId: string) {
  return { id: SHOW, name: 'Request Show', topic: 'tests', personaId };
}
function ctx() {
  return {
    at: new Date().toISOString(), time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'Request Show', topic: 'tests' },
  } as any;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const realRequestRun = requestAgent.run;

beforeEach(async () => {
  requestAgent.run = realRequestRun;
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  await settings.load();
  await settings.update({
    personas: [A, B], activePersonaId: A.id,
    shows: [show(A.id)], schedule: week(), scheduleOverride: null,
    llm: { pickerAgent: true },
    tts: { enabled: true },
  } as never);
  session.start(ctx());
});

after(async () => {
  requestAgent.run = realRequestRun;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  rmSync(root, { recursive: true, force: true });
});

test('the conversational request agent drops an intro if its captured host changes mid-run', async () => {
  const model = deferred<any>();
  let runArgs: any = null;
  requestAgent.run = async (args: any) => {
    runArgs = args;
    return model.promise;
  };

  const pending = runRequest(queue, ctx(), { requester: 'alice', text: 'play the blue one' });
  while (!runArgs) await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);
  const song = { id: 'requested-song', title: 'Blue Song', artist: 'Artist', duration: 180 };
  model.resolve({
    object: { kind: 'track', id: song.id, ack: 'Found it.', intro: 'Host A introduces the request.' },
    steps: 1, toolCalls: [], extras: { seen: new Map([[song.id, song]]) },
  });
  const result = await pending;

  assert.equal(runArgs.persona?.id, A.id, 'the agent prompt is pinned to the captured writer');
  assert.equal(result?.introScript, null);
  assert.equal(queue.upcoming.length, 1);
  assert.equal(queue.upcoming[0].track.id, song.id, 'the requested music is preserved');
  assert.equal(queue.upcoming[0].requestedBy, 'alice', 'listener provenance is preserved');
  assert.equal(queue.upcoming[0].intent, 'listener request');
  assert.equal(queue.upcoming[0].introScript, null);
  assert.equal(queue.upcoming[0].introPersona, null);
  assert.equal(queue.upcoming[0].introHostSpeech, null);
});

test('the stateless request-intro seam pins its writer across echo-guard regeneration', async () => {
  const regenerated = deferred<string>();
  const generatedFor: Array<string | null> = [];
  const requestText = 'play these exact eight words back to me right now';
  const pending = generateQueuedRequestIntro(
    { track: { id: 'stateless-song', title: 'Stateless Song', artist: 'Artist' }, context: ctx(), requestedBy: 'bob' },
    requestText,
    async (args: any) => {
      generatedFor.push(args.persona?.id ?? null);
      return generatedFor.length === 1 ? requestText : regenerated.promise;
    },
  );
  while (generatedFor.length < 2) await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);
  regenerated.resolve('Host A wrote a clean replacement intro.');
  const result = await pending;

  assert.deepEqual(generatedFor, [A.id, A.id], 'both prompts retain the original writer');
  assert.equal(result.introScript, null);
  assert.equal(result.introPersona, null);
  assert.equal(result.introHostSpeech, null);
  assert.equal(result.guard, 'echo-regenerated');
});

test('both stateless route cascades use the shared request provenance seam', () => {
  const route = readFileSync(join(process.cwd(), 'src/routes/request.ts'), 'utf8');
  assert.equal(route.match(/generateQueuedRequestIntro\(/g)?.length, 2);
  assert.doesNotMatch(route, /dj\.generateIntro\(/);
});

test('the request-agent system prompt accepts the captured writer explicitly', async () => {
  await settings.update({ shows: [show(B.id)] } as never);
  const prompt = requestSystem(A);
  assert.match(prompt, /Host A/);
  assert.doesNotMatch(prompt, /Host B/);
});
