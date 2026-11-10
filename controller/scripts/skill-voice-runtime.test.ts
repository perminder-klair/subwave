// Runtime half of the per-skill TTS voice override pin.
//
// scripts/skill-voice.test.ts covers the DATA contract — validation, the lenient
// disk read, the file round trip, and skillVoiceFor() called directly. This file
// covers the half that test cannot reach: the persona that actually reaches
// `queue.announce` / `tts.speak` at air time.
//
// The regression it guards: skillVoiceFor() was applied at the two solo announce
// sites, but nothing proved the slot survived the trip into TTS. Delete the
// `persona: voiced.persona` at either site and every schema/normalisation test
// here still passes — the station simply speaks the override in the booth log
// and the DJ's own voice on air.
//
// What is pinned, both directions:
//   1. SOLO with an override — forced run (Run now, per-skill cron, programme
//      beat) AND the autonomous director — the speaker's tts slot reaching
//      announce() is the skill's engine/voice, with the speaker's id, gain and
//      speed intact.
//   2. SOLO with NO override — the speaker object reaches announce() by
//      IDENTITY, not a rebuilt copy, so an upgraded station is byte-identical.
//   3. The speaker-less Run now — it names no persona, so announce() resolves
//      the on-air one itself. With an override the slot has to ride on that
//      persona, but the session turn still carries no speaker meta: the
//      override changes the voice and nothing else. Without one, announce()
//      gets no persona at all, exactly as before this feature.
//   4. CO-HOSTED — the override must NOT be applied. Each line speaks in its own
//      roster persona's voice, and an override would contradict the roster the
//      admin UI shows. Asserted through runCapability()'s own co-hosted branch.
//
// Run: `npm test -- skill-voice-runtime`.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';
import type { SessionContext } from '../src/broadcast/session.js';

// The runner hands this process its own empty STATE_DIR (scripts/run-tests.ts).
const root = process.env.STATE_DIR ?? '';
if (!root) throw new Error('STATE_DIR is unset: run this file through `npm test -- skill-voice-runtime`');

// Two skills on disk, written BEFORE the imports so loadSkills() sees them.
// `voiced-solo` pins a voice; `plain-solo` pins none — the control for "the
// speaker is passed through untouched". `voiced-duo` is co-hosted AND pins a
// voice: the case where the override must be ignored.
function writeSkill(slug: string, frontmatter: string[]) {
  const dir = join(root, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    'name: ' + slug,
    ...frontmatter,
    '---',
    `Say one grounded sentence about ${slug}.`,
    '',
  ].join('\n'));
}
writeSkill('voiced-solo', ['cooldown: 0', 'voiceEngine: remote', 'voiceId: Tyrone', 'voiceProvider: openai']);
writeSkill('plain-solo', ['cooldown: 0']);
writeSkill('voiced-duo', ['cooldown: 0', 'cohosts: true', 'voiceEngine: remote', 'voiceId: Tyrone']);

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { loadSkills, loadedCapabilities } = await import('../src/skills/loader.js');
const { agenticTick, directorAgent, forcedDirectorAgent, runCapability } = await import('../src/skills/_agent.js');

const SHOW = 's_voice';

function week() {
  const out: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) out[day] = Array(24).fill(SHOW);
  return out;
}
function show(personaId: string, guestPersonaIds: string[]) {
  return { id: SHOW, name: 'Voice Show', topic: 'tests', personaId, guestPersonaIds };
}
function ctx() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    clock: {}, weather: null, festival: null, dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'Voice Show', topic: 'tests' },
  } as unknown as SessionContext; // only the fields these skills read
}

// The persona fields this file reads off what TTS was handed.
interface SpokenPersona {
  id?: string;
  name?: string;
  tts: { engine: string; voice: string; cloudProvider?: string; gainDb?: number; speed?: number };
}
// The three queue internals stubbed below: the render, the single handoff and
// the batched one an exchange uses.
interface VoicePath {
  _speak: (text: string, opts?: { persona?: SpokenPersona | null }) => Promise<string>;
  _airVoice: (
    file: string, wav: string, text: string, gain: number,
    opts?: { onQueued?: (q: { voiceId: string; clipMs: number; estimatedAirInMs: number }) => void },
  ) => Promise<unknown>;
  _airExchange: (
    file: string,
    clips: { wavPath: string; text: string; gainDb: number; onQueued?: (q: { voiceId: string; clipMs: number; estimatedAirInMs: number }) => void }[],
  ) => Promise<({ voiceId: string; clipMs: number; aired: Promise<null> } | null)[]>;
}
const voicePath = queue as unknown as VoicePath;

// What TTS was handed. `_speak` is the ONE boundary every rendered segment
// crosses (announce, announceExchange, airPendingVoice), so capturing the
// persona there proves what speaks — not what the code intended to speak.
const spoken: Array<SpokenPersona | null> = [];
let renders = 0;

const realSpeak = voicePath._speak;
const realAirVoice = voicePath._airVoice;
const realAirExchange = voicePath._airExchange;
const realDirectorRun = directorAgent.run;
const realForcedRun = forcedDirectorAgent.run;

function stubVoicePath() {
  voicePath._speak = async (_text, opts) => {
    renders += 1;
    spoken.push(opts?.persona ?? null);
    return `/tmp/skill-voice-${renders}.wav`;
  };
  voicePath._airVoice = async (_file, _wav, _text, _gain, opts) => {
    const id = `voice-${renders}`;
    opts?.onQueued?.({ voiceId: id, clipMs: 1_000, estimatedAirInMs: 0 });
    return { voiceId: id, clipMs: 1_000, aired: Promise.resolve(null) };
  };
  voicePath._airExchange = async (_file, clips) => clips.map((clip, index) => {
    const id = `voice-${renders}-${index}`;
    clip.onQueued?.({ voiceId: id, clipMs: 1_000, estimatedAirInMs: 0 });
    return { voiceId: id, clipMs: 1_000, aired: Promise.resolve(null) };
  });
}

// The session turn a skill's aired line left. Post-air bookkeeping runs once
// the (stubbed, already resolved) aired promise settles, so give it a few turns.
async function segmentTurn(kind: string) {
  for (let i = 0; i < 100; i++) {
    const turn = session.getSession()?.messages.find(m => m.role === 'segment' && m.kind === kind);
    if (turn) return turn;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`no session turn for ${kind}`);
}

// One deterministic line, from whichever agent the run is on. Both solo paths
// (autonomous director, forced run) are driven here, so each test states which.
function stubAgents(line = 'A grounded line about the moment.') {
  directorAgent.run = async () => ({
    object: { air: true, reason: 'worth saying', segment: { kind: 'voiced-solo', text: line, sfx: null } },
    steps: 1, toolCalls: [], extras: undefined,
  });
  forcedDirectorAgent.run = async () => ({
    object: { text: line, sfx: null }, steps: 1, toolCalls: [], extras: undefined,
  });
}

const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Host', skills: ['voiced-solo', 'plain-solo', 'voiced-duo'], frequency: 'aggressive' };
// A distinct tts slot per persona, so "the override reached TTS" is visible as a
// change of engine rather than a coincidence.
const withTts = <T extends Record<string, unknown>>(p: T, tts: Record<string, unknown>): T & { tts: Record<string, unknown> } => ({ ...p, tts });
const H = withTts(HOST, { engine: 'piper', voice: '', cloudProvider: 'openai' });
const G = withTts({ ...template, id: 'p_guest', name: 'Guest', skills: H.skills, frequency: 'aggressive' },
  { engine: 'kokoro', voice: 'af_heart', cloudProvider: 'openai' });

beforeEach(async () => {
  spoken.length = 0;
  renders = 0;
  directorAgent.run = realDirectorRun;
  forcedDirectorAgent.run = realForcedRun;
  stubVoicePath();
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  await settings.load();
  await settings.update({
    personas: [H, G], activePersonaId: H.id,
    shows: [show(H.id, [G.id])], schedule: week(), scheduleOverride: null,
    skills: { enabled: { 'voiced-solo': true, 'plain-solo': true, 'voiced-duo': true } },
    llm: { pickerAgent: true },
    sfx: { enabled: false },
    djBehaviour: { holdDuckBetweenSpeakers: true },
  } as never);
  session.start(ctx());
  await loadSkills();
});

after(async () => {
  directorAgent.run = realDirectorRun;
  forcedDirectorAgent.run = realForcedRun;
  voicePath._speak = realSpeak;
  voicePath._airVoice = realAirVoice;
  voicePath._airExchange = realAirExchange;
  queue.senderBusy = false;
  await removeTempDir(root);
});

test('the fixtures loaded, and only the solo skills carry a voice override', () => {
  const caps = loadedCapabilities();
  const voiced = caps.find(c => c.kind === 'voiced-solo');
  const plain = caps.find(c => c.kind === 'plain-solo');
  const duo = caps.find(c => c.kind === 'voiced-duo');
  assert.ok(voiced && plain && duo, 'all three fixture skills loaded');
  assert.equal(voiced.voice?.engine, 'remote');
  assert.equal(voiced.voice?.voice, 'Tyrone');
  assert.equal(plain.voice, null, 'the control skill pins nothing');
  assert.equal(duo.cohosts, true);
  assert.equal(duo.voice?.engine, 'remote', 'the co-hosted skill DOES pin a voice — that is the point of case 4');
});

test('a forced solo run (Run now) hands TTS the skill voice, keeping the speaker identity', async () => {
  // Run now passes NO `persona`, so the speaker is the on-air one and
  // announce() is not told to pin it. The override still has to reach TTS.
  stubAgents();
  const result = await runCapability('voiced-solo', ctx());
  assert.equal(result.queued, true);

  assert.equal(spoken.length, 1, 'one clip rendered');
  const persona = spoken[0];
  assert.ok(persona);
  assert.equal(persona.tts.engine, 'remote', 'the override reached TTS, not just the booth log');
  assert.equal(persona.tts.voice, 'Tyrone');
  assert.equal(persona.id, H.id, 'speaker identity is preserved — only the tts slot moves');
});

test('the override changes only the voice: a speaker-less Run now still leaves no speaker meta', async () => {
  // Without an override, a Run now's session turn carries no personaId, and
  // prompt memory reads it as the session persona's own line. The override
  // must not change that, or a line voiced differently would also be
  // attributed differently.
  stubAgents();
  await runCapability('plain-solo', ctx());
  assert.equal((await segmentTurn('plain-solo')).meta?.personaId, undefined, 'the baseline');
  await runCapability('voiced-solo', ctx());
  assert.equal((await segmentTurn('voiced-solo')).meta?.personaId, undefined, 'the same with an override');
});

test('a skill with no override hands announce the speaker itself, by identity', async () => {
  // The control, and the upgrade property: no override means the SAME object
  // crosses into TTS, not a rebuilt copy with an equal-looking tts block.
  stubAgents();
  const result = await runCapability('plain-solo', ctx(), { persona: H });
  assert.equal(result.queued, true);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0], H, 'the speaker object itself — not a copy');
  assert.equal(spoken[0]?.tts.engine, 'piper', 'the on-air DJ keeps their own voice');
});

test('the autonomous director applies the override on its own solo path', async () => {
  stubAgents();
  await agenticTick(ctx());
  assert.equal(spoken.length, 1, 'the director aired one segment');
  assert.equal(spoken[0]?.tts.engine, 'remote');
  assert.equal(spoken[0]?.tts.voice, 'Tyrone');
});

test('a guest speaker keeps their id while speaking the skill voice', async () => {
  stubAgents();
  await runCapability('voiced-solo', ctx(), { persona: G, automaticHostSpeech: true });
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0]?.id, G.id);
  assert.equal(spoken[0]?.tts.engine, 'remote');
  // gainDb/speed are INHERITED from the speaker, so an override changes the
  // voice, never how loud or how fast.
  assert.equal(spoken[0]?.tts.gainDb, G.tts.gainDb ?? 0);
  // A named speaker is pinned, so its id rides in the turn as it always has.
  assert.equal((await segmentTurn('voiced-solo')).meta?.personaId, G.id);
});

test('without an override the speaker-less Run now is unchanged: no persona at all', async () => {
  // Run now passes neither `persona` nor `automaticHostSpeech`, so a skill with
  // no override must still reach announce() with NO persona — the pre-existing
  // behaviour, where the station default speaks. Widening this would silently
  // change the voice of every skill on every upgraded station.
  stubAgents();
  const result = await runCapability('plain-solo', ctx());
  assert.equal(result.queued, true);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0], null, 'no persona crossed into TTS, exactly as before this feature');
});

test('a co-hosted run ignores the override: each line keeps its roster voice', async () => {
  // The negative direction, and the one a schema test cannot see. runCohostedCapability
  // is stubbed by driving the real one through a deterministic agent — the roster
  // personas come back from the schema mapping, not from skillVoiceFor.
  const lines = [
    { speaker: H.id, text: 'The host opens the discussion from the brief.' },
    { speaker: G.id, text: 'The guest answers with a different reading of it.' },
  ];
  // cohosted.ts reaches the model through its own module scope, so this drives
  // the REAL generator over a fetch fixture: pool mode (no tool loop), one
  // forced `emit` call. No stub sits between the run and the schema mapping,
  // which is the half under test.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'emit', arguments: JSON.stringify({ reason: 'grounded', air: true, lines }) },
    }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    await settings.update({
      llm: {
        provider: 'openai-compatible', model: 'fixture-model',
        baseUrl: 'http://127.0.0.1:9/v1', pickerAgent: false, fallback: { enabled: false },
      },
    } as never);
    const result = await runCapability('voiced-duo', ctx());
    assert.equal(result.aired, true, 'the co-hosted run aired');
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: { pickerAgent: true } } as never);
  }

  assert.equal(spoken.length, 2, 'both cast members rendered');
  const byId = Object.fromEntries(spoken.map(p => [p?.id, p]));
  assert.equal(byId[H.id].tts.engine, 'piper', 'the host keeps the host voice');
  assert.equal(byId[G.id].tts.engine, 'kokoro', 'the guest keeps the guest voice');
  assert.notEqual(byId[H.id].tts.engine, 'remote', 'the skill override never reaches a co-hosted line');
  assert.notEqual(byId[G.id].tts.engine, 'remote');
});