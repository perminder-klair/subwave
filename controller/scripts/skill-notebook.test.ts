// Exercise real notebook files and delivery receipts without an LLM, TTS or mixer.
import assert from 'node:assert/strict';
import test, { beforeEach, after, afterEach, mock } from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-notebook-test-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const notebook = await import('../src/skills/notebook.js');
const { config } = await import('../src/config.js');
const { showSchema } = await import('../src/schemas/show.js');
const { NOTEBOOK_HISTORY_LIMIT, notebookMemoryUpdateForTurns } = await import('../src/skills/notebook-schema.js');
const { resetVoiceMarkers, pollVoiceMarker } = await import('../src/broadcast/queue/voice-marker.js');
const { runCohostedCapability } = await import('../src/skills/cohosted.js');
const station = settings.get();
const original = { shows: station.shows, personas: station.personas, scheduleOverride: station.scheduleOverride };
const host = { ...station.personas[0], id: 'p_host', name: 'Alex Vale' };
const skill = 'notebook-fixture';
const directory = join(root, 'skills', skill);
const file = join(directory, 'notebook.json');
const topic = 'Do songs need a chorus?';
const epoch = Date.now();
const update = { topic: { value: topic, turn: 1 }, contributions: [{ turn: 2, contributor: 'Sam North', summary: 'A memorable melody matters more than a chorus.' }] };
const lines = [{ persona: host, text: topic }, { persona: host, text: 'Sam North says a memorable melody matters more than a chorus.' }];

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: epoch });
  station.personas = [host];
  station.shows = [{ ...showSchema({ personaIds: [host.id], moodNames: null, themeIds: null, minTrackSeconds: null })
    .parse({ name: 'Notebook fixture', personaId: host.id }), id: 's_notebook' }];
  station.scheduleOverride = { showId: 's_notebook', startedAt: epoch - 60_000, expiresAt: epoch + 3600_000 };
  mkdirSync(directory, { recursive: true });
  rmSync(file, { force: true });
  mkdirSync(dirname(config.liquidsoap.voicePlayingFile), { recursive: true });
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId: 'bootstrap', startedAt: epoch / 1000 }));
  notebook.registerSkillNotebook(skill, directory, true);
});
afterEach(() => { Object.assign(station, original); mock.timers.reset(); });
after(() => { resetVoiceMarkers(); removeTempDir(root); });

function staged() {
  const lease = notebook.beginSkillNotebook(skill);
  return { lease, refs: notebook.stageNotebook(lease, update, lines) };
}
function render(ref: ReturnType<typeof notebook.stageNotebook>[number], text: string) {
  mkdirSync(config.piper.outDir, { recursive: true });
  const path = join(config.piper.outDir, `${ref.skillNotebook.voiceId}.wav`);
  writeFileSync(path, Buffer.alloc(44));
  notebook.notebookRendered(ref, path, text);
  return path;
}
function air(ref: ReturnType<typeof notebook.stageNotebook>[number]) {
  notebook.notebookAir(ref, ref.skillNotebook.voiceId, Date.now());
}
function committedTopic() {
  const { refs } = staged();
  refs.forEach((ref, index) => { render(ref, lines[index].text); assert.equal(notebook.notebookCanPublish(ref), true); air(ref); });
  return notebook.readSkillNotebook(skill);
}

test('generation, rendering and publication do not commit memory; only the matching aired turn does', () => {
  const { refs } = staged();
  assert.equal(notebook.notebookCanPublish(refs[0]), false);
  render(refs[0], topic);
  assert.equal(notebook.notebookCanPublish(refs[0]), true);
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  notebook.notebookAir(refs[0], 'wrong-voice', Date.now());
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  air(refs[0]);
  assert.equal(notebook.readSkillNotebook(skill).topic, topic);
  assert.equal(notebook.readSkillNotebook(skill).contributionCount, 0);
  render(refs[1], lines[1].text);
  assert.equal(notebook.notebookCanPublish(refs[1]), true);
  air(refs[1]);
  const saved = notebook.readSkillNotebook(skill);
  assert.equal(saved.history[0].contributor, 'Sam North');
  assert.equal(saved.contributionCount, 1);
  air(refs[1]);
  assert.deepEqual(notebook.readSkillNotebook(skill), saved, 'duplicate receipt is idempotent');
});

test('later turns cannot publish before earlier turns air; one skill permits only one outstanding run', () => {
  const { refs } = staged();
  render(refs[1], lines[1].text);
  assert.equal(notebook.notebookCanPublish(refs[1]), false);
  assert.throws(() => notebook.beginSkillNotebook(skill), /already has a notebook segment/);
});

test('cancellation releases unplayed work; an ambiguous handoff waits for a late receipt or lease expiry', () => {
  const { refs, lease } = staged();
  render(refs[0], topic);
  notebook.cancelNotebookRun(lease);
  assert.equal(notebook.notebookCanPublish(refs[0]), false);
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  const next = staged();
  render(next.refs[0], topic);
  assert.equal(notebook.notebookCanPublish(next.refs[0]), true);
  notebook.notebookAir(next.refs[0], next.refs[0].skillNotebook.voiceId, null);
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  assert.deepEqual(notebook.skillNotebookStatus(skill).pending?.turns.map(turn => turn.status), ['publishing', 'cancelled']);
  assert.throws(() => notebook.beginSkillNotebook(skill), /already has a notebook segment/);
  air(next.refs[0]);
  assert.equal(notebook.readSkillNotebook(skill).topic, topic);
  assert.equal(notebook.readSkillNotebook(skill).contributionCount, 0);
  assert.equal(notebook.skillNotebookStatus(skill).pending, null);
});

test('topic, spoken introduction and turn references are validated before staging', () => {
  const lease = notebook.beginSkillNotebook(skill);
  for (const invalid of [
    { topic: null, contributions: [] },
    { topic: { value: 'An unspoken question', turn: 1 }, contributions: [] },
    { topic: { value: topic, turn: 1 }, contributions: [{ ...update.contributions[0], turn: 3 }] },
    { topic: { value: topic, turn: 2 }, contributions: [{ ...update.contributions[0], turn: 1 }] },
  ]) assert.throws(() => notebook.stageNotebook(lease, invalid, [{ persona: host, text: topic }, { persona: host, text: topic }]));
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  assert.equal(notebook.skillNotebookStatus(skill).pending?.turns.length, 0);
});

test('TTS must preserve the first topic and remain inside the configured voice directory', () => {
  const { refs } = staged();
  assert.throws(() => notebook.notebookRendered(refs[0], join(root, 'outside.wav'), topic), /outside the voice directory/);
  assert.throws(() => notebook.notebookRendered(refs[0], join(config.piper.outDir, 'inside.wav'), 'A different question'), /no longer contains/);
});

test('a committed topic is fixed, snapshots are copies, and the next airing starts empty', () => {
  const saved = committedTopic();
  saved.history[0].summary = 'Mutated outside the notebook';
  assert.notEqual(notebook.readSkillNotebook(skill).history[0].summary, saved.history[0].summary);
  const lease = notebook.beginSkillNotebook(skill);
  assert.throws(() => notebook.stageNotebook(lease, { topic: { value: 'A new question', turn: 1 }, contributions: [] },
    [{ persona: host, text: 'A new question' }]), /topic is fixed/);
  notebook.cancelNotebookRun(lease);
  mock.timers.setTime(epoch + 7200_000);
  station.scheduleOverride = { showId: 's_notebook', startedAt: Date.now(), expiresAt: Date.now() + 3600_000 };
  const fresh = notebook.readSkillNotebook(skill);
  assert.notEqual(fresh.occurrence.id, saved.occurrence.id);
  assert.equal(fresh.topic, null);
  assert.deepEqual(fresh.history, []);
  assert.equal(fresh.contributionCount, 0);
});

test('notebooks are isolated by skill and unavailable without a real airing or mixer markers', () => {
  committedTopic();
  const other = join(root, 'skills', 'other-notebook');
  mkdirSync(other, { recursive: true });
  notebook.registerSkillNotebook('other-notebook', other, true);
  assert.equal(notebook.readSkillNotebook('other-notebook').topic, null);
  notebook.registerSkillNotebook(skill, directory, false);
  assert.throws(() => notebook.beginSkillNotebook(skill), /not enabled/);
  notebook.registerSkillNotebook(skill, directory, true);
  rmSync(config.liquidsoap.voicePlayingFile);
  assert.throws(() => notebook.beginSkillNotebook(skill), /confirmed mixer voice markers/);
  station.scheduleOverride = null;
  assert.throws(() => notebook.readSkillNotebook(skill), /active scheduled show or takeover/);
});

test('old queued speech cannot publish into a different airing or contaminate its memory', () => {
  const { lease, refs } = staged();
  render(refs[0], topic);
  station.scheduleOverride = { showId: 's_notebook', startedAt: epoch - 30_000, expiresAt: epoch + 3600_000 };
  assert.notEqual(notebook.readSkillNotebook(skill).occurrence.id, lease.occurrenceId);
  assert.equal(notebook.notebookCanPublish(refs[0]), false);
  air(refs[0]); // A late receipt belongs to the original airing only.
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  assert.equal(notebook.readSkillNotebook(skill).contributionCount, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).airings[lease.occurrenceId].topic, topic);
});

test('history is bounded while the lifetime contribution count remains accurate', () => {
  committedTopic();
  for (let index = 1; index <= NOTEBOOK_HISTORY_LIMIT + 2; index++) {
    const lease = notebook.beginSkillNotebook(skill);
    const text = `New point ${index}`;
    const [ref] = notebook.stageNotebook(lease, { topic: null, contributions: [{ turn: 1, contributor: host.name, summary: text }] }, [{ persona: host, text }]);
    render(ref, text); notebook.notebookCanPublish(ref); air(ref);
  }
  const saved = notebook.readSkillNotebook(skill);
  assert.equal(saved.history.length, NOTEBOOK_HISTORY_LIMIT);
  assert.equal(saved.contributionCount, NOTEBOOK_HISTORY_LIMIT + 3);
  assert.equal(saved.history.at(-1)?.summary, `New point ${NOTEBOOK_HISTORY_LIMIT + 2}`);
});

test('committed memory survives a fresh process loading the same skill and station snapshot', () => {
  const saved = committedTopic();
  writeFileSync(join(root, 'settings.json'), JSON.stringify(station));
  const settingsUrl = new URL('../src/settings.ts', import.meta.url).href;
  const notebookUrl = new URL('../src/skills/notebook.ts', import.meta.url).href;
  const code = `const s = await import(${JSON.stringify(settingsUrl)}); await s.load(); const n = await import(${JSON.stringify(notebookUrl)}); n.registerSkillNotebook(${JSON.stringify(skill)}, ${JSON.stringify(directory)}, true); console.log('SNAPSHOT:' + JSON.stringify(n.readSkillNotebook(${JSON.stringify(skill)})));`;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { env: { ...process.env, STATE_DIR: root }, encoding: 'utf8', timeout: 15_000 });
  const line = output.split('\n').find(value => value.startsWith('SNAPSHOT:'))!;
  assert.deepEqual(JSON.parse(line.slice('SNAPSHOT:'.length)), saved);
});

test('confirmed mixer markers recover an uncommitted receipt after re-registration', () => {
  const { refs } = staged();
  render(refs[0], topic);
  assert.equal(notebook.notebookCanPublish(refs[0]), true);
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId: refs[0].skillNotebook.voiceId, startedAt: epoch / 1000 }));
  notebook.registerSkillNotebook(skill, directory, true);
  pollVoiceMarker();
  assert.equal(notebook.readSkillNotebook(skill).topic, topic);
  assert.equal(notebook.readSkillNotebook(skill).revision, 1);
});

test('recovery offers only rendered unaired turns, preserving receipt IDs and committed history', async () => {
  const { refs } = staged();
  refs.forEach((ref, index) => render(ref, lines[index].text));
  notebook.registerSkillNotebook(skill, directory, true);
  let recovered = await notebook.recoverSkillNotebooks();
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].clips.map(clip => clip.meta.skillNotebook), refs.map(ref => ref.skillNotebook));
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  assert.equal(notebook.notebookCanPublish(refs[0]), true);
  air(refs[0]);
  recovered = await notebook.recoverSkillNotebooks();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].clips.length, 1);
  assert.deepEqual(recovered[0].clips[0].meta.skillNotebook, refs[1].skillNotebook);
  assert.equal(notebook.readSkillNotebook(skill).topic, topic);
  assert.equal(notebook.readSkillNotebook(skill).contributionCount, 0);
});

test('recovery discards unrendered or missing audio without inventing notebook contributions', async () => {
  staged();
  assert.deepEqual(await notebook.recoverSkillNotebooks(), []);
  assert.equal(notebook.skillNotebookStatus(skill).pending, null);
  const { refs } = staged();
  const paths = refs.map((ref, index) => render(ref, lines[index].text));
  rmSync(paths[0]);
  assert.deepEqual(await notebook.recoverSkillNotebooks(), []);
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  assert.equal(notebook.readSkillNotebook(skill).contributionCount, 0);
  assert.equal(notebook.skillNotebookStatus(skill).pending, null);
});

test('reset uses occurrence and revision checks; old leases cannot stage new speech', () => {
  const saved = committedTopic();
  const lease = notebook.beginSkillNotebook(skill);
  assert.throws(() => notebook.resetSkillNotebook(skill, saved.revision - 1, saved.occurrence.id), /revision changed/);
  assert.throws(() => notebook.resetSkillNotebook(skill, saved.revision, 'takeover:other:1'), /airing changed/);
  notebook.resetSkillNotebook(skill, saved.revision, saved.occurrence.id);
  assert.throws(() => notebook.stageNotebook(lease, update, lines), /lease expired/);
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
});

test('expired runs release the lock; corrupt files fail closed without overwriting evidence', () => {
  notebook.beginSkillNotebook(skill);
  mock.timers.setTime(epoch + 21 * 60_000);
  assert.equal(notebook.skillNotebookStatus(skill).pending, null);
  assert.ok(notebook.beginSkillNotebook(skill));
  writeFileSync(file, '{invalid JSON');
  assert.throws(() => notebook.readSkillNotebook(skill), /corrupt or unsupported/);
  assert.equal(readFileSync(file, 'utf8'), '{invalid JSON');
});

test('generation schemas limit solo updates to turn 1 and discussions to their available turns', () => {
  const value = { topic: null, contributions: [{ ...update.contributions[0], turn: 2 }] };
  assert.equal(notebookMemoryUpdateForTurns(1).safeParse(value).success, false);
  assert.equal(notebookMemoryUpdateForTurns(2).safeParse(value).success, true);
  assert.equal(notebookMemoryUpdateForTurns(2).safeParse({ ...value, contributions: [{ ...value.contributions[0], turn: 3 }] }).success, false);
});

test('a silent notebook generation releases its lease; invalid memory never reaches rendering', async () => {
  const args = { capability: { kind: skill, skill, notebook: true, desc: 'Invent a brief fictional discussion.' },
    host, guests: [], context: {}, situation: 'Current show.', segmentState: {} };
  const silent = await runCohostedCapability({ ...args, runObject: async () => ({ air: false, reason: 'No contribution.', text: '', memoryUpdate: null }) });
  assert.equal(silent.aired, false);
  assert.equal(notebook.skillNotebookStatus(skill).pending, null);
  await assert.rejects(runCohostedCapability({ ...args, runObject: async () => ({ air: true, reason: 'A question.', text: topic,
    memoryUpdate: { topic: { value: topic, turn: 1 }, contributions: [{ ...update.contributions[0], turn: 2 }] } }) }));
  assert.equal(notebook.readSkillNotebook(skill).topic, null);
  assert.equal(notebook.skillNotebookStatus(skill).pending, null);
});
