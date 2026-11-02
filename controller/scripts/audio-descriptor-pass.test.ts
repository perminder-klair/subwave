// The sound-descriptor pass end to end (music/audio-descriptor-pass.ts): a REAL
// SQLite DB, real sqlite-vec audio vectors and a stub analyzer sidecar answering
// /embed-text, so every query and the three-phase order are exercised. The
// selection maths is in scripts/audio-descriptors.test.ts.
//
// The fixture is one group of tracks growing through the phases on purpose: the
// floor crossing, an interrupted pass and the failures all act on the same rows.
// node:test runs the tests below in file order.
//
// The last tests pin "hints, not facts": a source scan of who may read the labels,
// and real rows through the projections that reach the picker and public reads.
// Run: `npm test -- audio-descriptor-pass`.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-descriptor-pass-'));
process.env.STATE_DIR = stateDir;
process.env.ADMIN_USER = 'descriptor-admin';
process.env.ADMIN_PASS = 'descriptor-pass';

function seededVector(seed: string): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < 512; i++) {
    const h = crypto.createHash('sha256').update(`${seed}#${i}`).digest();
    for (let b = 0; b + 4 <= h.length && out.length < 512; b += 4) {
      out.push(h.readInt32LE(b) / 2 ** 31);
    }
  }
  const n = Math.hypot(...out);
  return out.map((x) => x / n);
}

const tower = { calls: 0, audioCalls: 0, failing: false };
const server = createServer(async (req, res) => {
  const json = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') return json(200, { ok: true, engines: ['analyze'], analyze_text_capable: true });
  if (req.url === '/embed-text') {
    tower.calls += 1;
    if (tower.failing) return json(500, { error: 'tower down' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const { texts } = JSON.parse(Buffer.concat(chunks).toString()) as { texts: string[] };
    return json(200, { ok: true, embeddings: texts.map(seededVector) });
  }
  tower.audioCalls += 1;
  json(404, {});
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.ANALYZE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const db = await import('../src/music/library-db.js');
const { requireDb } = await import('../src/music/library-db/handle.js');
const library = await import('../src/music/library.js');
const settings = await import('../src/settings.js');
const { EMBED_TEXT_VERSION, formatTrackText } = await import('../src/music/embeddings.js');
const { runAudioDescriptorPass } = await import('../src/music/audio-descriptor-pass.js');
const { runAudioMoodPass } = await import('../src/music/audio-moods.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const {
  audioDescriptorVocabHash,
  DESCRIPTOR_CALIBRATION_VERSION,
  DESCRIPTOR_VOCAB,
  usableDescriptors,
} = await import('../src/music/audio-descriptors.js');

await settings.load();
await library.load();

after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTempDir(stateDir);
});

const LABELS = DESCRIPTOR_VOCAB.map((d) => d.label);
const groupOf = (label: string) => DESCRIPTOR_VOCAB.find((d) => d.label === label)?.group;
const CURRENT = `${audioDescriptorVocabHash()}:${DESCRIPTOR_CALIBRATION_VERSION}`;

const idOf = (i: number) => `t${String(i).padStart(4, '0')}`;
function addTracks(from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const id = idOf(i);
    db.upsertTrackMeta(id, { title: `Song ${i}`, artist: `Artist ${i % 40}`, album: `Album ${i % 60}`, duration: 200 });
    db.upsertTrackAudioVector(id, seededVector(id));
  }
}

const labelRow = (id: string) =>
  requireDb().prepare('SELECT audio_descriptors AS l FROM tracks WHERE id = ?').get(id) as { l: string | null };
const labelsOf = (id: string): string[] => JSON.parse(labelRow(id).l ?? 'null');
const allIds = () =>
  (requireDb().prepare('SELECT id FROM tracks ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
const labelCount = () => allIds().reduce((n, id) => n + (labelRow(id).l ? labelsOf(id).length : 0), 0);

test('no audio vectors, nothing to do', async () => {
  const before = tower.calls;
  assert.deepEqual(await runAudioDescriptorPass(), { scored: 0, scope: 0, skipped: 'no audio vectors' });
  assert.equal(tower.calls, before);
  assert.equal(db.getAudioDescriptorVocabHash(), null);
});

test('under the baseline floor it stores the scores and selects no labels', async () => {
  addTracks(0, 150);
  const stats = await runAudioDescriptorPass();
  assert.deepEqual(stats, { scored: 150, scope: 150, skipped: null, relabelled: 150, calibrated: false });
  const scores = db.getAudioDescriptorScores(idOf(0));
  assert.deepEqual(Object.keys(scores ?? {}).sort(), [...LABELS].sort(), 'the full map is on disk');
  assert.ok(allIds().every((id) => labelsOf(id).length === 0), 'no label, not a raw-cosine guess');
  assert.equal(
    db.getAudioDescriptorVocabHash(),
    `${audioDescriptorVocabHash()}:0`,
    'stamped uncalibrated, so the labels are still owed',
  );
});

test('an idle pass under the floor writes nothing and says nothing', async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  const towerBefore = tower.calls;
  const writesBefore = (requireDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  let stats;
  try {
    stats = await runAudioDescriptorPass();
  } finally {
    console.log = log;
  }
  assert.deepEqual(stats, { scored: 0, scope: 0, skipped: null, calibrated: false });
  assert.equal((requireDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n, writesBefore);
  assert.equal(tower.calls, towerBefore);
  assert.deepEqual(lines, []);
  assert.equal(db.getAudioDescriptorVocabHash(), `${audioDescriptorVocabHash()}:0`, 'the labels are still owed');
});

test('crossing the floor labels the tracks scored under it, across a page boundary', async () => {
  addTracks(150, 720);
  const stats = await runAudioDescriptorPass();
  assert.deepEqual(stats, { scored: 570, scope: 570, skipped: null, relabelled: 720, calibrated: true });
  assert.equal(db.getAudioDescriptorVocabHash(), CURRENT);
  const early = Array.from({ length: 150 }, (_, i) => idOf(i));
  assert.ok(early.some((id) => labelsOf(id).length > 0), 'an early track gained labels');
  for (const id of allIds()) {
    const labels = labelsOf(id);
    const count = (g: string) => labels.filter((l) => groupOf(l) === g).length;
    assert.ok(labels.every((l) => LABELS.includes(l)), id);
    assert.ok(count('instrument') <= 2 && count('vocal') <= 1 && count('production') <= 1, `${id}: ${labels}`);
  }
});

test('the pass decodes no audio', () => {
  assert.equal(tower.audioCalls, 0);
});

test('a settled pass does nothing and never reaches the tower', async () => {
  const before = tower.calls;
  assert.deepEqual(await runAudioDescriptorPass(), { scored: 0, scope: 0, skipped: null });
  assert.equal(tower.calls, before);
});

test('an incremental pass scores only the new track', async () => {
  const untouched = requireDb()
    .prepare('SELECT audio_descriptor_scores_json AS s FROM tracks WHERE id = ?').get(idOf(3));
  addTracks(720, 721);
  const stats = await runAudioDescriptorPass();
  assert.deepEqual(stats, { scored: 1, scope: 1, skipped: null, relabelled: 1, calibrated: true });
  assert.ok(labelRow(idOf(720)).l != null);
  assert.deepEqual(
    requireDb().prepare('SELECT audio_descriptor_scores_json AS s FROM tracks WHERE id = ?').get(idOf(3)),
    untouched,
  );
});

test('a crash between scoring and labelling is picked up, not lost', async () => {
  requireDb().prepare('UPDATE tracks SET audio_descriptors = NULL WHERE id IN (?, ?)').run(idOf(1), idOf(2));
  assert.deepEqual(db.idsNeedingAudioDescriptors(), [idOf(1), idOf(2)]);
  const stats = await runAudioDescriptorPass();
  assert.equal(stats.scored, 2);
  assert.deepEqual(db.idsNeedingAudioDescriptors(), []);
});

test('a changed derivation version relabels from disk, without the tower', async () => {
  db.setAudioDescriptorVocabHash(`${audioDescriptorVocabHash()}:${DESCRIPTOR_CALIBRATION_VERSION + 7}`);
  tower.failing = true;
  const before = tower.calls;
  const stats = await runAudioDescriptorPass();
  tower.failing = false;
  assert.deepEqual(stats, { scored: 0, scope: 0, skipped: null, relabelled: 721, calibrated: true });
  assert.equal(tower.calls, before);
  assert.equal(db.getAudioDescriptorVocabHash(), CURRENT);
});

test('a vocabulary hash change re-scores every vector-carrying track', async () => {
  // A retired prompt's labels and map, so a re-score can be told from a no-op.
  requireDb().prepare(`UPDATE tracks SET audio_descriptor_scores_json = '{"retired":0.9}'`).run();
  db.setAudioDescriptorVocabHash(`0000000000000000:${DESCRIPTOR_CALIBRATION_VERSION}`);
  const stats = await runAudioDescriptorPass();
  assert.deepEqual(stats, { scored: 721, scope: 721, skipped: null, relabelled: 721, calibrated: true });
  assert.deepEqual(Object.keys(db.getAudioDescriptorScores(idOf(0)) ?? {}).sort(), [...LABELS].sort());
  assert.equal(db.getAudioDescriptorVocabHash(), CURRENT);
});

test('moods and descriptors keep separate state and scores', async () => {
  const moods = await runAudioMoodPass();
  assert.equal(moods.scored, 721);
  assert.ok(db.getAudioMoodVocabHash());
  assert.notEqual(db.getAudioMoodVocabHash(), db.getAudioDescriptorVocabHash());
  const moodMap = db.getAudioMoodScores(idOf(0));
  const moodState = db.getAudioMoodVocabHash();
  db.setAudioDescriptorVocabHash('stale:1');
  await runAudioDescriptorPass();
  assert.equal(db.getAudioMoodVocabHash(), moodState);
  assert.deepEqual(
    db.getAudioMoodScores(idOf(0)),
    moodMap,
    'a descriptor in the mood map would skew its baselines',
  );
  assert.deepEqual(Object.keys(db.getAudioDescriptorScores(idOf(0)) ?? {}).sort(), [...LABELS].sort());
});

test('a failed text tower skips the pass, keeps the labels and stamps nothing', async () => {
  const count = labelCount();
  assert.ok(count > 0);
  db.setAudioDescriptorVocabHash('stale:1');
  tower.failing = true;
  const stats = await runAudioDescriptorPass();
  tower.failing = false;
  assert.deepEqual(stats, { scored: 0, scope: 721, skipped: 'text embedding failed' });
  assert.equal(db.getAudioDescriptorVocabHash(), 'stale:1');
  assert.equal(labelCount(), count);
  await runAudioDescriptorPass();
  assert.equal(db.getAudioDescriptorVocabHash(), CURRENT);
});

test('the analysis pass scores descriptors after moods, with no audio to analyse', async () => {
  requireDb().prepare('UPDATE tracks SET bpm = 120, analysis_version = 99').run();
  addTracks(721, 722);
  requireDb().prepare('UPDATE tracks SET bpm = 120, analysis_version = 99').run();
  const before = await runAnalysisPass({ audioBackfill: false, vocalBackfill: false });
  assert.equal(before.available, true);
  assert.ok(labelRow(idOf(721)).l != null, 'descriptors ran');
  assert.deepEqual(db.idsNeedingAudioMoods(), [], 'moods ran');
});

test('a descriptor failure never fails the analysis pass', async () => {
  addTracks(722, 723);
  requireDb().prepare('UPDATE tracks SET bpm = 120, analysis_version = 99').run();
  requireDb().exec('ALTER TABLE audio_embedding_meta DROP COLUMN descriptor_vocab_hash');
  await assert.rejects(runAudioDescriptorPass(), /descriptor_vocab_hash/, 'the fault is real');
  const stats = await runAnalysisPass({ audioBackfill: false, vocalBackfill: false });
  assert.equal(stats.available, true);
  assert.deepEqual(db.idsNeedingAudioMoods(), [], 'the mood pass still ran');
  requireDb().exec('ALTER TABLE audio_embedding_meta ADD COLUMN descriptor_vocab_hash TEXT');
  db.setAudioDescriptorVocabHash(CURRENT);
  await runAudioDescriptorPass();
});

test('the verdict flows through to the labels without a re-score', () => {
  const vocal = DESCRIPTOR_VOCAB.find((d) => d.group === 'vocal')!.label;
  const instrument = DESCRIPTOR_VOCAB.find((d) => d.group === 'instrument')!.label;
  db.setTrackAudioDescriptorLabelsBulk([{ id: idOf(5), labels: [instrument, vocal] }]);
  const setVocal = (ranges: unknown[] | null) =>
    requireDb().prepare('UPDATE tracks SET vocal_ranges_json = ? WHERE id = ?')
      .run(ranges == null ? null : JSON.stringify(ranges), idOf(5));

  setVocal(null);
  assert.deepEqual(usableDescriptors(db.getTrack(idOf(5))), [instrument, vocal]);
  setVocal([]);
  assert.deepEqual(usableDescriptors(db.getTrack(idOf(5))), [instrument]);
  assert.deepEqual(labelsOf(idOf(5)), [instrument, vocal], 'the stored labels were never rewritten');
  setVocal([{ startMs: 0, endMs: 60_000 }]);
  assert.deepEqual(usableDescriptors(db.getTrack(idOf(5))), [instrument, vocal]);
  setVocal(null);
});

// docs/internals/music.md says what has to be true before these words go in. The
// whole row is handed over, so a Sound line that starts reading them fails here.
test('selected descriptors change nothing in the embed text', () => {
  const id = idOf(5);
  const song = { title: 'T', artist: 'A', album: 'B', year: 2001, genres: ['Rock'] };
  const enrich = { lastfmTags: ['rock'], lyricExcerpt: 'la la' };
  db.setTrackAudioDescriptorLabelsBulk([{ id, labels: [] }]);
  const without = formatTrackText(song, enrich, db.getTrack(id));
  db.setTrackAudioDescriptorLabelsBulk([{ id, labels: ['piano', 'female vocals', 'lo-fi'] }]);
  const withLabels = formatTrackText(song, enrich, db.getTrack(id));
  assert.match(without, /Sound: /, 'the row has a Sound line to change');
  assert.equal(withLabels, without);
});

test('the operator dossier shows the usable labels, behind the admin gate', async () => {
  const { default: express } = await import('express');
  const { router } = await import('../src/routes/library/observatory.js');
  const app = express();
  app.use(router);
  const dossierServer = createServer(app);
  await new Promise<void>((resolve) => dossierServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(dossierServer.address() as AddressInfo).port}/library/observatory/track/${idOf(5)}`;
  try {
    assert.equal((await fetch(url)).status, 401, 'no public read of a CLAP guess');

    const vocal = DESCRIPTOR_VOCAB.find((d) => d.group === 'vocal')!.label;
    const instrument = DESCRIPTOR_VOCAB.find((d) => d.group === 'instrument')!.label;
    db.setTrackAudioDescriptorLabelsBulk([{ id: idOf(5), labels: [instrument, vocal] }]);
    requireDb().prepare(`UPDATE tracks SET vocal_ranges_json = '[]' WHERE id = ?`).run(idOf(5));

    const auth = `Basic ${Buffer.from('descriptor-admin:descriptor-pass').toString('base64')}`;
    const res = await fetch(url, { headers: { authorization: auth, 'x-subwave-console': '1' } });
    assert.equal(res.status, 200);
    const { track } = await res.json() as {
      track: { audioDescriptors: string[]; audioDescriptorScores: Record<string, number> };
    };
    assert.deepEqual(track.audioDescriptors, [instrument], 'a measured instrumental shows no vocal label');
    assert.ok(Number.isFinite(track.audioDescriptorScores[instrument]));
  } finally {
    dossierServer.closeAllConnections();
    await new Promise<void>((resolve) => dossierServer.close(() => resolve()));
    requireDb().prepare('UPDATE tracks SET vocal_ranges_json = NULL WHERE id = ?').run(idOf(5));
  }
});

test('labels are no musical signal in a vector, which never holds them', () => {
  const id = 'label-only';
  db.upsertTrackMeta(id, { title: 'Label', artist: 'Only', album: 'Row', duration: 200 });
  db.upsertTrackVector(id, new Array<number>(db.getEmbeddingDim() ?? 8).fill(0.1), null);
  db.setTrackAudioDescriptorLabelsBulk([{ id, labels: ['piano'] }]);
  db.invalidateStats();
  assert.equal(db.labelOnlyVectorCount(), 1);
  requireDb().prepare('DELETE FROM track_vectors WHERE id = ?').run(id);
  requireDb().prepare('DELETE FROM tracks WHERE id = ?').run(id);
});

test('selected descriptors ask nobody to re-embed', async () => {
  const coverage = await import('../src/music/library-coverage.js');
  db.setEmbeddingMeta('fixture-model', db.getEmbeddingDim() ?? 8, 'plain', EMBED_TEXT_VERSION);
  assert.equal(db.getAudioDescriptorVocabHash(), CURRENT, 'labels exist');
  assert.equal((await coverage.get()).embeddingFormatStale, false);
  requireDb().prepare('DELETE FROM embedding_meta WHERE pk = 1').run();
});

test('an id rotation carries labels and scores as one group', () => {
  assert.deepEqual(
    db.columnPlan().grouped.find((g) => g.anchor === 'audio_descriptors')?.cols,
    ['audio_descriptors', 'audio_descriptor_scores_json'],
  );
});

test('a v34 database gains the columns, and a wound-back one survives', async () => {
  const raw = requireDb();
  assert.equal(raw.pragma('user_version', { simple: true }), 35);
  raw.exec(`
    ALTER TABLE tracks DROP COLUMN audio_descriptors;
    ALTER TABLE tracks DROP COLUMN audio_descriptor_scores_json;
    ALTER TABLE audio_embedding_meta DROP COLUMN descriptor_vocab_hash;
  `);
  raw.pragma('user_version = 34');
  db.close();
  await db.open({ embeddingDim: db.getEmbeddingDim() ?? 8, adoptStoredDim: true });
  assert.equal(requireDb().pragma('user_version', { simple: true }), 35);
  assert.equal(db.getAudioDescriptorVocabHash(), null);
  assert.equal(labelRow(idOf(0)).l, null);
  assert.deepEqual(db.getTrack(idOf(0))?.audioDescriptors, [], 'an unscored row reads as none');

  requireDb().pragma('user_version = 34');
  db.close();
  await db.open({ embeddingDim: db.getEmbeddingDim() ?? 8, adoptStoredDim: true });
  assert.equal(requireDb().pragma('user_version', { simple: true }), 35);

  await runAudioDescriptorPass();
  assert.equal(db.getAudioDescriptorVocabHash(), CURRENT);
});

test('labels never reach a projection the picker or a public read is built from', () => {
  const id = idOf(7);
  db.setTrackAudioDescriptorLabelsBulk([{ id, labels: ['piano', 'male vocals', 'lo-fi'] }]);
  requireDb().prepare(`UPDATE tracks SET moods = '["calm"]', energy = 'low' WHERE id = ?`).run(id);
  const reads: Record<string, unknown> = {
    get: library.get(id),
    slimById: library.slimById(id),
    filter: library.filter({ q: 'Song 7', limit: 50 }).rows,
    energyPool: db.songsByEnergy('low'),
  };
  for (const [name, value] of Object.entries(reads)) {
    assert.ok(value, name);
    assert.doesNotMatch(JSON.stringify(value), /audioDescriptors|male vocals/, name);
  }
  assert.deepEqual(db.getTrack(id)?.audioDescriptors, ['piano', 'male vocals', 'lo-fi']);
});

test('only the operator dossier reads the labels', () => {
  const src = resolvePath(dirname(fileURLToPath(import.meta.url)), '../src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  walk(src);
  const readers = files
    .filter((f) => /audioDescriptors|usableDescriptors/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(src, f))
    .sort();
  assert.deepEqual(readers, [
    'music/audio-descriptors.ts',          // defines them
    'music/library-db/rows.ts',            // the row mapper
    'music/library-db/types.ts',
    'routes/library/observatory.ts',       // the admin dossier, behind requireAdmin
  ], 'a new reader is a decision: descriptors are CLAP guesses, not facts');
});

// A clear that drops the audio moods has dropped the vector they came from.
// Descriptors left behind are never re-scored, because the incremental scope only
// sees a NULL label.
test('whatever clears the audio moods clears the descriptors beside them', () => {
  const src = resolvePath(dirname(fileURLToPath(import.meta.url)), '../src/music/library-db/tracks.ts');
  const sql = readFileSync(src, 'utf8');
  const clears = (column: string) => sql.split(`${column} = NULL`).length - 1;
  assert.ok(clears('audio_moods') > 0);
  assert.equal(clears('audio_descriptors'), clears('audio_moods'));
  assert.equal(clears('audio_descriptor_scores_json'), clears('audio_mood_scores_json'));
});

// Last, because it drops the vectors every test above stands on.
test('a re-analyse drops the descriptors with the vectors they came from', () => {
  assert.ok(db.getAudioDescriptorScores(idOf(0)));
  db.clearAnalysis();
  assert.equal(db.audioVectorCount(), 0);
  assert.equal(labelRow(idOf(0)).l, null);
  assert.equal(db.getAudioDescriptorScores(idOf(0)), null);
});
