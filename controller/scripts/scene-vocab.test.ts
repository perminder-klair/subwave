// Scene vocabulary consolidation (issue #1577) — the operator merging
// near-duplicate genre tags after a full library pass.
//
// Two halves that only work together, so both are pinned here:
//
//   1. the REWRITE (library-db/scenes.ts) — one transaction over the rows that
//      carry a retired value, against a real SQLite library because the
//      dedupe, the generated `genre` column and the dirty-vector marking are
//      all things a pure test would happily pass on while broken;
//   2. the RULE (music/scene-vocab.ts) — recorded so `subsonic.songGenres`
//      keeps applying it. Without this half the next Navidrome walk writes the
//      file's own tags straight back over the merge, which is the failure this
//      file exists to catch: the walk runs during the same tag pass that
//      produced the noise.
//
// Run: npm test -- scene-vocab

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-scene-vocab-'));

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const sceneVocab = await import('../src/music/scene-vocab.js');
const subsonic = await import('../src/music/subsonic.js');

await library.load();

const ALIAS_FILE = join(process.env.STATE_DIR!, 'scene-aliases.json');

function seed(id: string, genres: string[]): void {
  db.upsertTrackMeta(id, { title: id, artist: 'Someone', album: 'A Record', genres });
}

// ---------------------------------------------------------------------------
// Pure — the folding and the flatness of the rule set
// ---------------------------------------------------------------------------

test('the scene key folds case and whitespace but never punctuation', () => {
  assert.equal(sceneVocab.sceneKey('  Hip  Hop '), 'hip hop');
  assert.equal(sceneVocab.sceneKey('HIP HOP'), sceneVocab.sceneKey('hip hop'));
  // "Hip-Hop" vs "Hip Hop" is a choice the operator makes by merging, not one
  // a normaliser makes for them — fold it here and the two rows would collapse
  // in the listing before anyone chose which spelling survives.
  assert.notEqual(sceneVocab.sceneKey('Hip-Hop'), sceneVocab.sceneKey('Hip Hop'));
});

test('a merge onto an already-retired value resolves through to the survivor', () => {
  const first = sceneVocab.planAliases([], ['hiphop'], 'Hip Hop', '2026-01-01T00:00:00Z');
  const second = sceneVocab.planAliases(first.aliases, ['Hip Hop'], 'Hip-Hop', '2026-01-02T00:00:00Z');
  const map = sceneVocab.aliasMapOf(second.aliases);
  // Both retired spellings land on the final survivor in ONE hop — a chain
  // would make alias() a walk, and a walk can loop.
  assert.equal(map.get('hiphop'), 'Hip-Hop');
  assert.equal(map.get('hip hop'), 'Hip-Hop');
  assert.equal([...map.values()].every(v => v === 'Hip-Hop'), true);
});

test('merging onto a target that is itself retired lands on the final survivor', () => {
  const first = sceneVocab.planAliases([], ['Alt Rock'], 'Alternative', '2026-01-01T00:00:00Z');
  const second = sceneVocab.planAliases(first.aliases, ['Indie Rock'], 'Alt Rock', '2026-01-02T00:00:00Z');
  assert.equal(second.target, 'Alternative');
  assert.equal(sceneVocab.aliasMapOf(second.aliases).get('indie rock'), 'Alternative');
});

test('a value merged onto itself records no rule', () => {
  const plan = sceneVocab.planAliases([], ['Rock', 'rock'], 'Rock', '2026-01-01T00:00:00Z');
  assert.deepEqual(plan.aliases, []);
  assert.deepEqual(plan.recorded, []);
});

test('applying the map dedupes a track that carried both spellings', () => {
  const map = sceneVocab.aliasMapOf([{ from: 'hip hop', to: 'Hip-Hop', at: 'now' }]);
  assert.deepEqual(sceneVocab.applyAliases(['Hip Hop', 'Hip-Hop', 'Soul'], map), ['Hip-Hop', 'Soul']);
});

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

test('the vocabulary counts every distinct stored value, biggest first', () => {
  seed('t1', ['Hip-Hop', 'Soul']);
  seed('t2', ['Hip-Hop']);
  seed('t3', ['Hip Hop']);
  seed('t4', ['hiphop']);
  seed('t5', ['Soul']);
  seed('t6', []);

  const scenes = library.scenes();
  const counts = Object.fromEntries(scenes.map(s => [s.value, s.tracks]));
  assert.equal(counts['Hip-Hop'], 2);
  assert.equal(counts['Soul'], 2);
  // The near-duplicates are their own rows — seeing them separately IS the
  // feature; a listing that pre-folded them would hide the thing to fix.
  assert.equal(counts['Hip Hop'], 1);
  assert.equal(counts['hiphop'], 1);
  assert.equal(scenes[0]!.tracks >= scenes[scenes.length - 1]!.tracks, true);
  // A track with no genres contributes no row rather than an empty one.
  assert.equal(scenes.some(s => s.value.trim() === ''), false);
});

// ---------------------------------------------------------------------------
// The rewrite
// ---------------------------------------------------------------------------

test('merging rewrites the retired values and leaves everything else alone', async () => {
  const result = await library.consolidateScenes(['Hip Hop', 'hiphop'], 'Hip-Hop');

  assert.equal(result.target, 'Hip-Hop');
  assert.equal(result.tracksChanged, 2);
  assert.deepEqual(result.sources.sort(), ['Hip Hop', 'hiphop']);

  assert.deepEqual(db.getTrack('t3')!.genres, ['Hip-Hop']);
  assert.deepEqual(db.getTrack('t4')!.genres, ['Hip-Hop']);
  // Untouched rows stay byte-identical, including tag ORDER.
  assert.deepEqual(db.getTrack('t1')!.genres, ['Hip-Hop', 'Soul']);
  assert.deepEqual(db.getTrack('t5')!.genres, ['Soul']);

  const counts = Object.fromEntries(library.scenes().map(s => [s.value, s.tracks]));
  assert.equal(counts['Hip-Hop'], 4);
  assert.equal(counts['Hip Hop'], undefined);
  assert.equal(counts['hiphop'], undefined);
});

test('a track carrying both spellings ends up with one tag, in place', async () => {
  seed('t7', ['Drum & Bass', 'Techno', 'Drum and Bass']);
  const result = await library.consolidateScenes(['Drum and Bass'], 'Drum & Bass');
  assert.equal(result.tracksChanged, 1);
  // Deduped, and the surviving tag keeps the position the first spelling held —
  // the scalar `genre` column is GENERATED over genres[0], so a rewrite that
  // reordered would silently change what every genre-indexed read answers.
  assert.deepEqual(db.getTrack('t7')!.genres, ['Drum & Bass', 'Techno']);
  const row = library.get('t7');
  assert.equal(row.genre, 'Drum & Bass');
});

test('the generated genre column follows a merge on the first tag', async () => {
  seed('t8', ['nu-jazz', 'Downtempo']);
  assert.equal(library.get('t8').genre, 'nu-jazz');
  await library.consolidateScenes(['nu-jazz'], 'Nu Jazz');
  assert.equal(library.get('t8').genre, 'Nu Jazz');
});

test('a rewritten row with a text vector is marked for re-embedding', async () => {
  seed('t9', ['Trip Hop']);
  seed('t10', ['Trip Hop']);
  const dim = db.getEmbeddingDim()!;
  db.upsertTrackVector('t9', new Array(dim).fill(0.01), null);
  assert.deepEqual(db.textVectorDirtyIds(), []);

  const result = await library.consolidateScenes(['Trip Hop'], 'Trip-Hop');
  assert.equal(result.tracksChanged, 2);
  // Only the embedded row: the genre line is part of the embed text, so its
  // vector is now stale. The unembedded one has nothing to refresh.
  assert.equal(result.vectorsDirtied, 1);
  assert.deepEqual(db.textVectorDirtyIds(), ['t9']);
});

test('merging a value nothing carries changes no rows but still records the rule', async () => {
  const result = await library.consolidateScenes(['Vaporwave'], 'Chillwave');
  assert.equal(result.tracksChanged, 0);
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.recorded, ['vaporwave']);
});

// ---------------------------------------------------------------------------
// The rule — what keeps a merge alive across the next walk
// ---------------------------------------------------------------------------

test('the next walk normalises through the recorded rule', () => {
  // What walkNavidrome does with a Subsonic child: songGenres() is the single
  // ingest normaliser, so this is the exact call the walk makes.
  const walked = subsonic.songGenres({ genres: [{ name: 'hiphop' }, { name: 'Soul' }] });
  assert.deepEqual(walked, ['Hip-Hop', 'Soul']);

  // And the round trip: re-walking the merged row must not restore the noise.
  db.upsertTrackMeta('t4', { title: 't4', genres: walked });
  assert.deepEqual(db.getTrack('t4')!.genres, ['Hip-Hop', 'Soul']);
});

test('the legacy scalar genre goes through the same rule', () => {
  assert.deepEqual(subsonic.songGenres({ genre: 'HIP HOP' }), ['Hip-Hop']);
});

test('an unaliased station normalises exactly as before', () => {
  assert.deepEqual(
    subsonic.songGenres({ genres: [{ name: ' Post-Punk ' }, { name: 'post-punk' }, 'Dub'] }),
    ['Post-Punk', 'Dub'],
  );
});

test('the rules survive a restart', () => {
  const onDisk = JSON.parse(readFileSync(ALIAS_FILE, 'utf8')) as {
    aliases: Array<{ from: string; to: string }>;
  };
  assert.equal(onDisk.aliases.some(a => a.from === 'hiphop' && a.to === 'Hip-Hop'), true);

  sceneVocab._resetForTests();
  assert.equal(sceneVocab.alias('Soul'), 'Soul'); // never merged, passes through
  assert.equal(sceneVocab.alias('HipHop'), 'Hip-Hop'); // same key as 'hiphop'
  assert.equal(sceneVocab.alias('hiphop'), 'Hip-Hop');
  assert.equal(sceneVocab.list().some(a => a.from === 'hip hop'), true);
});

test('forgetting a rule stops future walks folding it, and keeps the rewritten rows', async () => {
  assert.equal(await sceneVocab.forget('hiphop'), true);
  assert.equal(await sceneVocab.forget('hiphop'), false);
  assert.equal(subsonic.songGenres({ genre: 'hiphop' })[0], 'hiphop');
  // The rows the merge already rewrote are untouched — there is nothing to
  // restore them to.
  assert.deepEqual(db.getTrack('t3')!.genres, ['Hip-Hop']);
});
