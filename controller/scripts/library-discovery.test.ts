import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-library-discovery-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { buildGenreSuggest } = await import('../src/music/genre-suggest.js');
const { projectionStatus } = await import('../src/music/map-projection.js');
await db.open({ embeddingDim: 3 });
await library.load();
after(() => {
  library.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test('genre neighbours preserve ties, counts, threshold and the eight-result cap', () => {
  const genres = Array.from({ length: 11 }, (_, i) => `Genre ${i}`);
  genres.push('Orthogonal', 'Opposite');
  for (const genre of genres) {
    db.upsertTrackMeta(genre, { title: genre, artist: 'Artist', genres: [genre] });
    db.upsertTrackTags(genre, { moods: ['calm'], energy: 'low', source: 'manual' });
  }
  db.upsertTrackMeta('second', { title: 'Second track', artist: 'Artist', genres: ['Genre 0'] });
  db.upsertTrackTags('second', { moods: ['calm'], energy: 'low', source: 'manual' });

  const withoutVectors = buildGenreSuggest();
  assert.equal(withoutVectors.hasEmbeddings, false);
  assert.deepEqual(withoutVectors.related, {});
  assert.deepEqual(withoutVectors.genres[0], { value: 'Genre 0', songCount: 2 });

  for (const genre of genres.slice(0, 2)) db.upsertTrackVector(genre, [1, 0, 0], null);
  assert.equal(buildGenreSuggest().hasEmbeddings, false);
  for (const genre of genres.slice(2)) {
    const vector = genre === 'Orthogonal' ? [0, 1, 0] : genre === 'Opposite' ? [-1, 0, 0] : [1, 0, 0];
    db.upsertTrackVector(genre, vector, null);
  }

  const result = buildGenreSuggest();
  const centroidOrder = db.genreCentroids().map(c => c.genre);
  assert.equal(result.hasEmbeddings, true);
  for (const genre of genres.slice(0, 11)) {
    const expected = centroidOrder
      .filter(other => other !== genre && other !== 'Orthogonal' && other !== 'Opposite')
      .slice(0, 8)
      .map(value => ({ value, songCount: value === 'Genre 0' ? 2 : 1 }));
    assert.deepEqual(result.related[genre], expected);
  }
  assert.deepEqual(result.related.Orthogonal, []);
  assert.deepEqual(result.related.Opposite, []);
  assert.strictEqual(buildGenreSuggest(), result, 'unchanged library uses the cached result');
});

test('map status reads its count and metadata once and retains drift thresholds', () => {
  assert.equal(projectionStatus().stale, false, 'an empty audio index needs no map');
  const vector = new Float32Array(db.AUDIO_EMBEDDING_DIM);
  vector[0] = 1;
  for (let i = 0; i < 1001; i++) {
    db.upsertTrackAudioVector(`audio-${i}`, vector);
    if (i === 48) assert.equal(projectionStatus().stale, false, 'fewer than 50 vectors need no map');
  }
  assert.equal(projectionStatus().stale, true, 'a missing map needs projection');
  db.setMapProjectionMeta('umap-1', 'audio', 952);
  assert.equal(projectionStatus().stale, false, 'absolute drift below 50 is tolerated');
  db.setMapProjectionMeta('umap-1', 'audio', 951);
  assert.equal(projectionStatus().stale, false, 'relative drift below 5% is tolerated');
  db.setMapProjectionMeta('umap-1', 'audio', 950);
  assert.equal(projectionStatus().stale, true);
  db.setMapProjectionMeta('old', 'audio', 1001);
  assert.equal(projectionStatus().stale, true, 'an old algorithm needs projection');
  db.setMapProjectionMeta('umap-1', 'text', 1001);
  assert.equal(projectionStatus().stale, true, 'a different vector space needs projection');
  db.setMapProjectionMeta('umap-1', 'audio', 1001);

  const handle = db.getDb()!;
  const prepare = handle.prepare.bind(handle);
  const statements: string[] = [];
  handle.prepare = (sql: string) => { statements.push(sql); return prepare(sql); };
  try {
    const result = projectionStatus();
    assert.equal(result.audioVectors, 1001);
    assert.equal(result.meta?.count, 1001);
    assert.equal(result.stale, false);
  } finally {
    handle.prepare = prepare;
  }
  assert.equal(statements.length, 2);
  assert.equal(statements.filter(sql => sql.includes('track_audio_vectors')).length, 1);
  assert.equal(statements.filter(sql => sql.includes('map_projection_meta')).length, 1);
});
