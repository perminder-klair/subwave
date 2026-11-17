// Untaggable tracks (#2283). The tagger prompt tells the model to answer
// {"moods":[],"energy":"medium"} when it cannot tell, and a silent hidden track
// gets that answer every time. Before the fix the batch loop counted it as
// tagged ("Mood tagging done 11/11") while the library kept it untagged, and
// nothing remembered the answer, so the same tracks went to the LLM every run.
//
// Pinned here:
//   - an empty answer is never counted, leaves the row untagged with every tag
//     column NULL (clearTrackTags' shape, not moods='[]'), and is marked;
//   - the marker holds only while the input, prompt stamp and model match, and
//     any tag write or an operator clear drops it;
//   - the seed selector never picks a remembered track;
//   - an answer naming only off-vocabulary moods is told apart.
//
// The batch loop calls the LLM through tagger-core, so that part runs in a child
// with tagger-core mocked (as in handoff-release-wiring.test.ts).
// Run: `npm test -- tag-untaggable`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const SILENT = Array.from({ length: 3 }, (_, i) => `silence-${i}`);
const MODEL = 'mock:model';

async function openDb() {
  const db = await import('../src/music/library-db.js');
  await db.open({ embeddingDim: 4 });
  for (const id of SILENT) {
    db.upsertTrackMeta(id, { title: '[silence]', artist: '[no artist]', album: 'Follow the Leader', genres: ['Nu Metal'] });
  }
  db.upsertTrackMeta('song', { title: 'Freak on a Leash', artist: 'Korn', album: 'Follow the Leader', genres: ['Nu Metal'] });
  db.upsertTrackMeta('off-vocab', { title: 'Odd One', artist: 'Korn', album: 'Follow the Leader', genres: ['Nu Metal'] });
  return db;
}

// ---- child: the batch loop against a mocked LLM ----------------------------
if (process.argv[2] === 'batch') {
  const { mock } = await import('node:test');
  const answers: Record<string, unknown> = {};
  let calls = 0;
  mock.module(new URL('../src/music/tagger-core.ts', import.meta.url).href, {
    namedExports: {
      TAGGER_CONTRACT_VERSION: 1,
      tagBatch: async (songs: Array<{ title?: string }>) => {
        calls += 1;
        return songs.map(s =>
          s.title === 'Freak on a Leash' ? { moods: ['energetic'], energy: 'high' }
            : s.title === 'Odd One' ? { moods: [], energy: 'medium', offVocab: true }
              : { moods: [], energy: 'medium' });
      },
      tagOne: async () => { throw new Error('unused'); },
    },
  });
  const db = await openDb();
  const { llmTagInBatches } = await import('../src/music/tag-library/tag.js');
  const { rememberedUntaggable } = await import('../src/music/tag-library/tag-input.js');
  const ids = [...SILENT, 'song', 'off-vocab'];
  const r = await llmTagInBatches(ids, 25, 'hash-1', 'llm', [{ label: MODEL }], { phase: 'seed' });
  const row = db.requireDb()
    .prepare('SELECT moods, energy, source, model, tagged_at, untaggable_key FROM tracks WHERE id = ?')
    .get(SILENT[0]);
  answers.result = r;
  answers.calls = calls;
  answers.untagged = db.untaggedIds().sort();
  answers.row = row;
  answers.remembered = [...rememberedUntaggable('hash-1', [MODEL])].sort();
  answers.rememberedOtherModel = [...rememberedUntaggable('hash-1', ['other:model'])];
  answers.rememberedOtherPrompt = [...rememberedUntaggable('hash-2', [MODEL])];
  process.stdout.write(`\nRESULT ${JSON.stringify(answers)}\n`);
  process.exit(0);
}

// ---- parent ------------------------------------------------------------------
if (process.argv[2] !== 'batch') {
  test('an empty answer is untaggable, never counted as tagged', async () => {
    const root = createTempDir(join(tmpdir(), 'subwave-untaggable-'));
    try {
      const out = spawnSync(process.execPath, [
        '--experimental-test-module-mocks', '--no-warnings', '--import', 'tsx', fileURLToPath(import.meta.url), 'batch',
      ], { env: { ...process.env, STATE_DIR: root }, encoding: 'utf8', timeout: 30_000 });
      assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
      const line = out.stdout.split('\n').find(l => l.startsWith('RESULT '));
      assert.ok(line, out.stdout);
      const a = JSON.parse(line!.slice('RESULT '.length));

      assert.equal(a.calls, 1);
      assert.equal(a.result.tagged, 1, 'only the track with a mood counts');
      assert.deepEqual(a.result.untaggable.sort(), [...SILENT, 'off-vocab'].sort());
      assert.deepEqual(a.result.byLeg, { [MODEL]: 1 });
      assert.deepEqual(a.untagged, [...SILENT, 'off-vocab'].sort(), 'the library agrees with the count');
      // clearTrackTags' shape: no moods='[]' row carrying a stale source/model/tagged_at.
      assert.equal(a.row.moods, null);
      assert.equal(a.row.energy, null);
      assert.equal(a.row.source, null);
      assert.equal(a.row.model, null);
      assert.equal(a.row.tagged_at, null);
      assert.match(a.row.untaggable_key, /^[0-9a-f]{64}$/);
      // Remembered under the same prompt stamp and model; asked again otherwise.
      assert.deepEqual(a.remembered, [...SILENT, 'off-vocab'].sort());
      assert.deepEqual(a.rememberedOtherModel, []);
      assert.deepEqual(a.rememberedOtherPrompt, []);
    } finally {
      await removeTempDir(root);
    }
  });

  const db = await openDb();
  const { tagInputFor, untaggableKey, rememberedUntaggable } = await import('../src/music/tag-library/tag-input.js');
  const { selectSeeds } = await import('../src/music/seed-selector.js');
  const { sanitizeTag } = await import('../src/music/tagger-core.js');
  const settings = await import('../src/settings.js');

  const mark = (id: string, hash = 'hash-1', model = MODEL) =>
    db.markTrackUntaggable(id, untaggableKey(tagInputFor(db.getTrack(id)!), hash, model));

  test('the marker holds only while what would be asked is unchanged', () => {
    for (const id of SILENT) mark(id);
    assert.deepEqual([...rememberedUntaggable('hash-1', [MODEL])].sort(), SILENT);
    // Dual-LLM mode: a marker from either leg holds.
    mark('song', 'hash-1', 'fallback:model');
    assert.ok(rememberedUntaggable('hash-1', [MODEL, 'fallback:model']).has('song'));
    assert.ok(!rememberedUntaggable('hash-1', [MODEL]).has('song'));

    // A metadata edit changes the input, so the track is asked again.
    db.upsertTrackMeta(SILENT[0], { title: 'Hidden Track', artist: 'Korn', album: 'Follow the Leader', genres: ['Nu Metal'] });
    assert.ok(!rememberedUntaggable('hash-1', [MODEL]).has(SILENT[0]));

    // Any tag write drops the marker; so does an operator clear.
    db.upsertTrackTags(SILENT[1], { moods: ['calm'], energy: 'low', source: 'propagated', confidence: 0.9 });
    db.clearTrackTags(SILENT[2]);
    const keys = db.requireDb()
      .prepare(`SELECT id, untaggable_key AS k FROM tracks WHERE id IN (?, ?)`)
      .all(SILENT[1], SILENT[2]) as Array<{ id: string; k: string | null }>;
    assert.deepEqual(keys.map(r => r.k), [null, null]);
    assert.deepEqual(db.untaggableMarks().map(m => m.id).sort(), [SILENT[0], 'song'].sort());
    // Coverage is unchanged: a marked track is still untagged.
    assert.ok(db.untaggedIds().includes(SILENT[0]));
    assert.equal(db.hasTags(SILENT[0]), false);
  });

  test('the seed selector never picks a remembered track', async () => {
    for (const id of [...SILENT, 'song', 'off-vocab']) db.clearTrackTags(id);
    mark(SILENT[0]);
    mark(SILENT[1]);
    const skip = rememberedUntaggable('hash-1', [MODEL]);
    assert.equal(skip.size, 2);
    const sel = await selectSeeds({ seedCount: 50, skip });
    assert.deepEqual(sel.seeds.filter(id => skip.has(id)), []);
    assert.ok(sel.seeds.includes('song'), 'the rest are still seeded');
    assert.ok(sel.seeds.includes(SILENT[2]));
  });

  test('sanitizeTag tells an off-vocabulary answer from "can\'t tell"', () => {
    const vocab = settings.moodVocab();
    assert.ok(vocab.length > 0);
    assert.deepEqual(sanitizeTag({ moods: [], energy: 'medium' }), { moods: [], energy: 'medium' });
    assert.deepEqual(sanitizeTag({ moods: ['not-a-mood-xyz'], energy: 'high' }), { moods: [], energy: 'high', offVocab: true });
    assert.deepEqual(sanitizeTag({ moods: [vocab[0], 'not-a-mood-xyz'], energy: 'low' }), { moods: [vocab[0]], energy: 'low' });
    // Unchanged otherwise: at most three, bad energy nulls.
    assert.deepEqual(sanitizeTag({ moods: vocab.slice(0, 5), energy: 'loud' }), { moods: vocab.slice(0, 3), energy: null });
  });
}
