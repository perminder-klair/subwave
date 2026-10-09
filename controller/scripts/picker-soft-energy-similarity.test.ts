import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'subwave-energy-similarity-'));
process.env.STATE_DIR = root;
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const { buildPickerTools, pickerScope } = await import('../src/llm/tools.js');
const { buildPickerContext } = await import('../src/llm/internal/tools/picker/scope.js');
const { shortlistPickPrompt } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
await library.load();
after(() => { library.shutdown(); rmSync(root, { recursive: true, force: true }); });
for (let i = 0; i < 12; i++) {
  db.upsertTrackMeta(`energy-${i}`, { title: `Track ${i}`, artist: i < 4 ? 'Same Artist' : `Artist ${i}`, duration: 240 });
  db.upsertTrackTags(`energy-${i}`, { moods: ['calm'], energy: i < 2 ? 'low' : 'high', source: 'manual' });
}
async function mood(scope = {}) {
  const { tools } = buildPickerTools(scope);
  return await tools.tracksByMood.execute!({ mood: 'calm', energy: 'low' }, { toolCallId: 'energy', messages: [], context: undefined }) as any;
}

test('preferred energy leads, filling from the same mood without exceeding the artist cap', async () => {
  const rows = await mood();
  assert.equal(rows.length, 8);
  assert.ok(rows.slice(0, 2).every((s: any) => s.energy === 'low'));
  assert.ok(rows.slice(2).every((s: any) => s.energy === 'high'));
  assert.ok(rows.filter((s: any) => s.artist === 'Same Artist').length <= 3);
});

test('recency and exclusions empty the preferred band without starving the mood', async () => {
  const rows = await mood({ hardRecentIds: new Set(['energy-0']), excludedIds: new Set(['energy-1']) });
  assert.equal(rows.length, 8);
  assert.ok(rows.every((s: any) => s.energy === 'high'));
});

test('an explicit strict energy lock remains hard even when the preferred band is filtered out', async () => {
  assert.deepEqual((await mood({ energyLock: ['low'], hardRecentIds: new Set(['energy-0', 'energy-1']) })).tracks, []);
  const rows = await mood({ energyLock: ['high'] });
  assert.equal(rows.length, 8);
  assert.ok(rows.every((s: any) => s.energy === 'high'));
});

test('cosine evidence retains kind, reference and zero; invalid or unlabelled scores are omitted', () => {
  const ctx = buildPickerContext(pickerScope());
  const rows = ctx.collect([
    { id: 'valid', title: 'Valid', artist: 'A', _similarity: 0 },
    { id: 'invalid', title: 'Invalid', artist: 'B', _similarity: NaN },
    { id: 'out-of-range', title: 'Invalid', artist: 'C', _similarity: 4 },
  ], 8, { similarity: { kind: 'audio', reference: 'seed' } });
  assert.deepEqual(rows.find(s => s.id === 'valid')?.similarity, { kind: 'audio', reference: 'seed', score: 0 });
  assert.ok(rows.filter(s => s.id !== 'valid').every(s => !s.similarity));
  const unlabelled = ctx.collect([{ id: 'unlabelled', _similarity: 0.9 }]);
  assert.equal(unlabelled[0].similarity, undefined);
  const prompt = shortlistPickPrompt(rows);
  assert.match(prompt, /"similarity":\{"kind":"audio","reference":"seed","score":0\}/);
  assert.match(prompt, /Neither is BPM\/key compatibility/);
  assert.match(prompt, /same kind and reference/);
});

test('an audio seed rescued by the text index labels its actual evidence as text', () => {
  for (const [id, text, audio] of [['text-seed', true, false], ['both', true, true], ['text-neighbour', true, false]] as const) {
    db.upsertTrackMeta(id, { title: id, artist: id });
    db.upsertTrackTags(id, { moods: ['calm'], energy: 'low', source: 'manual' });
    if (text) { const vector = new Float32Array(db.getEmbeddingDim()!); vector[0] = 1; db.upsertTrackVector(id, vector, null); }
    if (audio) { const vector = new Float32Array(512); vector[0] = 1; db.upsertTrackAudioVector(id, vector); }
  }
  db.invalidateStats();
  const ctx = buildPickerContext(pickerScope());
  const rescued = ctx.seedSimilarity('text-seed', 'audio');
  assert.equal(rescued.fellBack, true);
  assert.ok(rescued.tracks.length > 0);
  assert.ok(rescued.tracks.every(s => s.similarity.kind === 'text' && s.similarity.reference === 'text-seed'));
});
