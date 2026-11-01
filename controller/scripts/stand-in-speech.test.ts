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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'subwave-stand-in-'));
process.env.STATE_DIR = root;

function writeSkill(slug: string, frontmatter = '') {
  const dir = join(root, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\ncooldown: 60\n${frontmatter}---\nSay something.\n`);
}
writeSkill('forced-words');

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { standInToken } = await import('../src/broadcast/stand-in-policy.js');
const { enqueuePick, trimLinkToIntro } = await import('../src/broadcast/dj-agent/enqueue.js');
const { normalizeForDisplay } = await import('../src/audio/speech-text.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');
const { loadSkills } = await import('../src/skills/loader.js');
const { forcedDirectorAgent, runCapability } = await import('../src/skills/_agent.js');

// ── the matcher ──────────────────────────────────────────────────────────────

test('the stand-ins seen on air and their kin are caught', () => {
  for (const line of [
    'placeholder', 'Placeholder.', '"placeholder"', '[placeholder]', '<placeholder>',
    'PLACEHOLDER TEXT', 'TBD', 'TODO', 'N/A', 'NULL', 'undefined', 'Your text here',
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
    '[Music swells] Here we go.', 'Insert the tape and press play: Plakias, 1986.',
  ]) assert.equal(standInToken(line), null, `should keep ${JSON.stringify(line)}`);
});

// One of each bracket shape, as the model wrote it. Normalising empties the
// short bracket and the tag, and only strips the long bracket's brackets, so
// these are the lines a gate behind the normaliser cannot see.
const TEMPLATES = {
  'a short [...]': '[Insert weather update here]',
  'a [...] past the 80-character cue cap': '[Insert a short weather update here for the listeners, covering the temperature, the wind and tonight]',
  'a <...>': '<placeholder>',
  'a {...}': '{your text}',
};

test('markup that leaves nothing to say is a stand-in, not an empty line', () => {
  for (const [shape, line] of Object.entries(TEMPLATES)) assert.ok(standInToken(line), shape);
  assert.ok(standInToken('[Music swells]'), 'a cue with no words after it never aired');
  assert.ok(standInToken('<br>'), 'a bare tag normalises to nothing');
});

test('todo and null are words elsewhere, so only the capitals are a stand-in', () => {
  // "Todo." is Spanish and Portuguese for everything, "Null." German for zero.
  for (const line of ['Todo.', '¡Todo!', 'todo', 'Null.', 'Null!', 'null.', 'null'])
    assert.equal(standInToken(line), null, `should keep ${JSON.stringify(line)}`);
  for (const line of ['TODO', 'TODO.', '"TODO"', 'NULL', 'NULL.'])
    assert.ok(standInToken(line), `should catch ${JSON.stringify(line)}`);
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
const realForcedRun = forcedDirectorAgent.run;
const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '' };
const GUEST = { ...template, id: 'p_guest', name: 'Niki', language: '' };
const SHOW = 's_stand_in';

let spoken: string[] = [];
const droppedAsStandIn = () => queue.djLog.some(entry => /dropped a stand-in line/.test(entry.message));
const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

beforeEach(async () => {
  spoken = [];
  queue.djLog = [];
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue._pendingVoice = null;
  seams._speak = async (text: string) => { spoken.push(text); return wav; };
  seams._airVoice = async () => true;
  forcedDirectorAgent.run = realForcedRun;
  await settings.update({
    personas: [HOST, GUEST], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'Stand-in', topic: 'tests', personaId: HOST.id, energies: ['medium'] }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    tts: { enabled: true },
    skills: { enabled: { 'forced-words': true } },
    sfx: { enabled: false },
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
  forcedDirectorAgent.run = realForcedRun;
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
  // Not a bracket: normalising alone empties one, gate or no gate.
  await queue.announceAtNextTrack('TBD', 'station-id', { persona: HOST as never });
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
    { persona: GUEST as never, text: 'TBD' },
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

for (const [shape, line] of Object.entries(TEMPLATES)) {
  test(`announce drops ${shape} and reports it as a stand-in`, async () => {
    const out = await queue.announce(line, 'programme-feature', { persona: HOST as never });
    assert.equal(out.accepted, false);
    assert.equal(out.reason, 'stand-in');
    assert.deepEqual(spoken, []);
  });

  test(`the deferred path drops ${shape}`, async () => {
    await queue.announceAtNextTrack(line, 'station-id', { persona: HOST as never });
    assert.deepEqual(spoken, []);
    assert.ok(droppedAsStandIn(), 'the gate dropped it, not the normaliser');
  });

  test(`an exchange skips ${shape} and airs the real line`, async () => {
    const real = 'Storms over Crete tonight, the ferries are docked.';
    await queue.announceExchange([
      { persona: HOST as never, text: real },
      { persona: GUEST as never, text: line },
    ], 'banter', { castNames: [HOST.name, GUEST.name] });
    assert.deepEqual(spoken, [real]);
    assert.ok(droppedAsStandIn(), 'the gate dropped it, not the normaliser');
  });

  test(`a request intro that is ${shape} is queued without it`, async () => {
    await queue.push({ track: { id: 'intro', title: 'Song', artist: 'Artist' } as never, introScript: line, introPersona: HOST as never });
    assert.equal(queue.upcoming.find(i => i.track.id === 'intro')!.introScript, null);
  });

  test(`a pick link that is ${shape} goes before the budget trim can launder it`, async () => {
    const song = { id: 'link', title: 'Song', artist: 'Artist' };
    assert.equal(trimLinkToIntro(line, song, HOST as never), null);
    await enqueuePick(queue, song, 'tests', 'tests', line, null, {}, { introPersona: HOST as never });
    assert.equal(queue.upcoming.find(i => i.track.id === 'link')!.introScript, null);
  });

  test(`a forced run on ${shape} stands down as a stand-in, not as a queue refusal`, async () => {
    forcedDirectorAgent.run = (async () => ({ object: { text: line, sfx: null }, steps: 1, toolCalls: [], extras: undefined })) as never;
    await loadSkills();
    const run = await runCapability('forced-words', {} as never);
    assert.equal(run.aired, false);
    assert.match(String(run.reason), /stand-in/);
    assert.deepEqual(spoken, []);
  });
}

// A stand-in in costume. The test reads the raw line, the line a label away, and
// what normalising leaves of each, because a model reaches for all of these and
// each one alone gets past a test of the raw line.
const LONG_TEMPLATE = '[Placeholder for the weather update, which should cover the temperature, the wind and the forecast for tonight]';
const DISGUISED = {
  'a quoted long template': `"${LONG_TEMPLATE}"`,
  'a quoted short template': '"[Insert weather update here]"',
  'a quoted long template and a full stop': `"${LONG_TEMPLATE}".`,
  'doubled braces': '{{ your weather update }}',
  'a tag around a word': '<p>TBD</p>',
  'a tag around a long template': `<p>${LONG_TEMPLATE}</p>`,
  'a stand-in and a trailing cue': 'placeholder [laughs]',
  'emphasis around a template': '**[Insert weather update here]**',
  'another persona\'s label': 'Niki: placeholder',
  'a role label': 'DJ: placeholder',
  'a field label': 'Script: placeholder',
  'a bold label': '**Niki:** placeholder',
  'a label on a short template': 'Niki: [Insert reply here]',
  'a label on a quoted long template': `Niki: "${LONG_TEMPLATE}"`,
  'a label on a tag': 'DJ: <p>TBD</p>',
};

// Real lines that look like some of the above. A label stays on the air as it
// was: only the test looks past it.
const REAL_SPEECH = {
  'a line with another persona\'s label': 'Niki: hello there',
  'a short aside before its words': '[laughs] That was a long one.',
  'a long aside in brackets': '[This aside runs well past the eighty character cue cap and it is still just a person talking on the radio]',
  'a line in quotes': '"A quoted line, start to finish."',
  'a colon that is no label': 'Attention : voici le morceau',
  'a stand-in word after a sentence': 'That was Efdemin. The date: TBD.',
  'a template word opening a sentence': 'Insert the tape and press play: Plakias, 1986.',
  'an aside in round brackets': '(Insert coin to continue, as the arcades said.)',
  'a labelled word that is one elsewhere': 'Niki: Todo.',
  'a bold word': 'The **only** ferry out of Chania tonight.',
};

for (const [shape, line] of Object.entries(DISGUISED)) {
  test(`announce drops ${shape} and reports it as a stand-in`, async () => {
    const out = await queue.announce(line, 'programme-feature', { persona: HOST as never });
    assert.equal(out.accepted, false);
    assert.equal(out.reason, 'stand-in');
    assert.deepEqual(spoken, []);
    assert.ok(droppedAsStandIn(), 'the gate dropped it, not the normaliser');
  });

  test(`the deferred path and an exchange drop ${shape}`, async () => {
    await queue.announceAtNextTrack(line, 'station-id', { persona: HOST as never });
    assert.deepEqual(spoken, []);
    const real = 'Storms over Crete tonight, the ferries are docked.';
    await queue.announceExchange([
      { persona: HOST as never, text: real },
      { persona: GUEST as never, text: line },
    ], 'banter', { castNames: [HOST.name, GUEST.name] });
    assert.deepEqual(spoken, [real]);
  });

  test(`push() drops ${shape} and says so`, async () => {
    let reported = 0;
    await queue.push({
      track: { id: 'told', title: 'Song', artist: 'Artist' } as never, introScript: line, introPersona: HOST as never,
      onStandInDropped: () => { reported += 1; },
    });
    assert.equal(queue.upcoming.find(i => i.track.id === 'told')!.introScript, null);
    assert.equal(reported, 1, 'a caller recording its own copy must hear of it');
  });
}

for (const [shape, line] of Object.entries(REAL_SPEECH)) {
  test(`${shape} airs`, async () => {
    const out = await queue.announce(line, 'programme-feature', { persona: HOST as never });
    assert.equal(out.accepted, true);
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0], normalizeForDisplay(line));
    assert.ok(!droppedAsStandIn());
  });
}

test('a line the gate passes is not dropped by a later look at its display form', () => {
  // push() checks the line once and the render checks it again. If those two
  // disagree, the caller has already recorded as said a line that never airs.
  for (const line of Object.values(REAL_SPEECH)) {
    assert.equal(standInToken(line), null, line);
    assert.equal(standInToken(normalizeForDisplay(line)), null, line);
  }
});

test('the label comes off before the line is judged', async () => {
  const out = await queue.announce(`${HOST.name}: [Insert weather update here]`, 'programme-feature', { persona: HOST as never });
  assert.equal(out.reason, 'stand-in');
  assert.deepEqual(spoken, []);
});

test('operator text is still normalised, and a bracket with nothing in it is no stand-in of theirs', async () => {
  const out = await queue.announce('[Insert weather update here]', 'dj-speak', { meta: { verbatim: true } });
  assert.equal(out.accepted, false, 'normalising it leaves nothing to say');
  assert.equal(out.reason, undefined, 'a verbatim line is never judged');
  await queue.announce('**Placeholder**', 'dj-speak', { meta: { verbatim: true } });
  assert.deepEqual(spoken, ['Placeholder']);
});

// What a queue snapshot holds: push() has stamped the flag on every item since
// #1715, so a link recovered from before the gate arrives already marked checked.
const recovered = (introScript: string) => ({
  track: { id: 'old', title: 'Song', artist: 'Artist' }, introScript, introPersona: HOST,
  introHostSpeech: null, introKind: 'link', introLabelChecked: true, introWav: null, introAired: false,
}) as never as Parameters<typeof queue.cleanUnrenderedIntro>[0];

test('a recovered link from before the gate is cleaned the same way', () => {
  const item = recovered('TBD');
  queue.cleanUnrenderedIntro(item);
  assert.equal(item.introScript, null);
  assert.equal(item.introPersona, null);
});

test('a recovered stand-in is not rendered ahead of its seam', async () => {
  const item = recovered('TBD');
  assert.equal(queue.startIntroRender(item), null, 'nothing to wait for');
  assert.deepEqual(spoken, []);
});

test('a recovered stand-in is not rendered at air time either', async () => {
  const item = recovered('TBD');
  await queue.airIntro(item);
  assert.deepEqual(spoken, []);
  assert.equal(item.introWav, null);
});

test('a checked link keeps its words: the check neither relabels nor renormalises it', async () => {
  const line = `${HOST.name}: a second name kept on purpose.`;
  const item = recovered(line);
  await queue.startIntroRender(item);
  assert.deepEqual(spoken, [line]);
  assert.equal(item.introScript, line);
});

test('an unchecked legacy link is still cleaned as it was', async () => {
  const item = recovered(`${HOST.name}: **a real line**`);
  item.introLabelChecked = false;
  queue.cleanUnrenderedIntro(item);
  assert.equal(item.introScript, 'a real line');
  assert.equal(item.introLabelChecked, true);
});

test('operator text airs as typed, even a stand-in word (verbatim is exempt)', async () => {
  await queue.announce('Placeholder', 'dj-speak', { meta: { verbatim: true } });
  assert.deepEqual(spoken, ['Placeholder']);
});
