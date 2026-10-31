// A stand-in line never airs. A model told "silence is not an option" but
// handed no data answered {"text": "placeholder"}, and the DJ read the word
// out (eleven times, from a prompt-only skill). stand-in-policy decides what
// a stand-in is; these pin the matcher and the speech paths that must consult
// it (announce, announceAtNextTrack, announceExchange, and a pushed pick's
// link or request intro), asserting on what reaches _speak.
//
// Run: npm test -- stand-in-speech

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'subwave-stand-in-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { standInToken } = await import('../src/broadcast/stand-in-policy.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

// ── the matcher ──────────────────────────────────────────────────────────────

test('the stand-ins seen on air and their kin are caught', () => {
  for (const line of [
    'placeholder', 'Placeholder.', '"placeholder"', '[placeholder]', '<placeholder>',
    'PLACEHOLDER TEXT', 'TBD', 'todo', 'N/A', 'null', 'undefined', 'Your text here',
    '{your text}', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.', '...', '—', '…',
  ]) assert.ok(standInToken(line), `should catch ${JSON.stringify(line)}`);
});

test('template text left in brackets is a stand-in; a real aside in brackets is not', () => {
  for (const line of [
    '[Insert weather update here]', '[Placeholder for the news segment]', '{Your intro here}',
    '<TBD: closing line>', '[insert track intro].',
  ]) assert.ok(standInToken(line), `should catch ${JSON.stringify(line)}`);
  for (const line of [
    '[laughs] That was a long one.', '(Insert coin to continue, as the arcades said.)',
    '[Music swells]', 'Insert the tape and press play: Plakias, 1986.',
  ]) assert.equal(standInToken(line), null, `should keep ${JSON.stringify(line)}`);
});

test('a one-word reply a guest could give in banter is speech', () => {
  for (const line of ['None.', 'Empty.', 'Blank.', 'Example?', 'Text!', 'Content.', 'Line.', 'Script?', 'To do.'])
    assert.equal(standInToken(line), null, `should keep ${JSON.stringify(line)}`);
});

test('real speech airs, even when it names a stand-in word', () => {
  for (const line of [
    'Plakias, the placeholder for every good summer.',
    'That was Efdemin. The date is TBD, but the festival is coming.',
    'None of the boats left Chania today.',
    'Test pressing only, that one.',
    'Na!',
    'Καλησπέρα από το Πλακιά.',
    'Ok.',
  ]) assert.equal(standInToken(line), null, `should keep ${JSON.stringify(line)}`);
});

test('an empty line is the callers\' own "no line" case, not a stand-in', () => {
  assert.equal(standInToken(''), null);
  assert.equal(standInToken('   '), null);
  assert.equal(standInToken(null), null);
});

// ── the speech paths ─────────────────────────────────────────────────────────

type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<boolean> };
const seams = queue as unknown as Seams;
const realSpeak = seams._speak;
const realAirVoice = seams._airVoice;
const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '' };
const GUEST = { ...template, id: 'p_guest', name: 'Niki', language: '' };
const SHOW = 's_stand_in';

let spoken: string[] = [];
const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

beforeEach(async () => {
  spoken = [];
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue._pendingVoice = null;
  seams._speak = async (text: string) => { spoken.push(text); return wav; };
  seams._airVoice = async () => true;
  await settings.update({
    personas: [HOST, GUEST], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'Stand-in', topic: 'tests', personaId: HOST.id, energies: ['medium'] }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    tts: { enabled: true },
  } as never);
  session.start({
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'Stand-in', topic: 'tests' },
  } as unknown as Parameters<typeof session.start>[0]);
});

after(async () => {
  seams._speak = realSpeak;
  seams._airVoice = realAirVoice;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

test('announce drops a stand-in before TTS and reports it not accepted, as a stand-in', async () => {
  const out = await queue.announce('placeholder', 'programme-feature', { persona: HOST as never });
  assert.equal(out.accepted, false);
  assert.equal(out.reason, 'stand-in', 'the skill runner backs off on this, not on a queue refusal');
  assert.deepEqual(spoken, []);
  const empty = await queue.announce('', 'programme-feature', { persona: HOST as never });
  assert.equal(empty.reason, undefined, 'no line is not a stand-in');
});

test('announce still airs real speech', async () => {
  const line = 'Storms over Crete tonight, the ferries are docked in Chania.';
  const out = await queue.announce(line, 'programme-feature', { persona: HOST as never });
  assert.equal(out.accepted, true);
  assert.deepEqual(spoken, [line]);
});

test('the deferred path drops a stand-in too', async () => {
  await queue.announceAtNextTrack('[placeholder]', 'station-id', { persona: HOST as never });
  assert.deepEqual(spoken, []);
});

test('an exchange airs its real lines and skips a stand-in one', async () => {
  await queue.announceExchange([
    { persona: HOST as never, text: 'Big rescue exercise in Heraklion this week.' },
    { persona: GUEST as never, text: 'placeholder' },
  ], 'banter', { castNames: [HOST.name, GUEST.name] });
  assert.deepEqual(spoken, ['Big rescue exercise in Heraklion this week.']);
});

test('an exchange whose every line is a stand-in airs nothing', async () => {
  const aired = await queue.announceExchange([
    { persona: HOST as never, text: 'placeholder' },
    { persona: GUEST as never, text: '[Insert reply here]' },
  ], 'banter', { castNames: [HOST.name, GUEST.name] });
  assert.equal(aired, false);
  assert.deepEqual(spoken, []);
});

test('a pick whose link is a stand-in is queued without a link', async () => {
  await queue.push({ track: { id: 'linked', title: 'Song', artist: 'Artist' } as never, introScript: 'placeholder', introPersona: HOST as never });
  const item = queue.upcoming.find(i => i.track.id === 'linked')!;
  assert.ok(item, 'the track is still queued');
  assert.equal(item.introScript, null);
  assert.equal(item.introPersona, null);
  await queue.push({ track: { id: 'real', title: 'Song', artist: 'Artist' } as never, introScript: 'Here comes a good one.', introPersona: HOST as never });
  assert.equal(queue.upcoming.find(i => i.track.id === 'real')!.introScript, 'Here comes a good one.');
});

test('a recovered link from before the gate is cleaned the same way', () => {
  const item = { track: { id: 'old', title: 'Song', artist: 'Artist' }, introScript: 'TBD', introPersona: HOST, introLabelChecked: false } as never as Parameters<typeof queue.cleanUnrenderedIntro>[0];
  queue.cleanUnrenderedIntro(item);
  assert.equal(item.introScript, null);
});

test('operator text airs as typed, even a stand-in word (verbatim is exempt)', async () => {
  await queue.announce('Placeholder', 'dj-speak', { meta: { verbatim: true } });
  assert.deepEqual(spoken, ['Placeholder']);
});
