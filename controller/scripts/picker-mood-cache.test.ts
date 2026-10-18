import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { z } from 'zod';

const dir = mkdtempSync(join(tmpdir(), 'subwave-picker-mood-cache-'));
process.env.STATE_DIR = dir;
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const { buildPickerTools } = await import('../src/llm/tools.js');
await library.load();
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

for (let index = 0; index < 36; index++) {
  const id = `mood-${index}`;
  db.upsertTrackMeta(id, { title: id, artist: `Artist ${index}`, album: `Album ${index}`, duration: 180 });
  db.upsertTrackTags(id, { moods: ['calm'], energy: index < 24 ? 'low' : 'high', source: 'manual' });
}

const candidatesSchema = z.array(z.object({ id: z.string(), energy: z.string() }));
async function runMood(tools: ReturnType<typeof buildPickerTools>['tools'], energy: 'low' | 'high' | null) {
  const tool = tools.tracksByMood;
  assert.ok(tool?.execute);
  return candidatesSchema.parse(await tool.execute({ mood: 'calm', energy }, {
    toolCallId: 'mood-cache-test', messages: [], context: undefined,
  }));
}

test('real mood tools reuse the pool while repeated and different energy passes find fresh tracks', async () => {
  const { tools, seen } = buildPickerTools();
  const database = db.getDb();
  assert.ok(database);
  const prepare = database.prepare.bind(database);
  let moodQueries = 0;
  database.prepare = (sql: string) => {
    if (/FROM track_moods m JOIN tracks t/.test(sql)) moodQueries++;
    return prepare(sql);
  };
  try {
    const first = await runMood(tools, 'low');
    const second = await runMood(tools, 'low');
    const higher = await runMood(tools, 'high');
    const unfiltered = await runMood(tools, null);
    for (const group of [first, second, higher, unfiltered]) assert.equal(group.length, 8);
    assert.ok([...first, ...second].every(track => track.energy === 'low'));
    assert.ok(higher.every(track => track.energy === 'high'));
    assert.equal(new Set([...first, ...second, ...higher, ...unfiltered].map(track => track.id)).size, 32);
    assert.equal(seen.size, 32);
    assert.equal(moodQueries, 1, 'energy passes share one real SQLite mood query for this pick');
  } finally { database.prepare = prepare; }
});

test('a new pick reads changed tags instead of inheriting the previous pick cache', async () => {
  const original = buildPickerTools();
  const first = await runMood(original.tools, 'low');
  assert.equal(first.length, 8);
  for (let index = 0; index < 36; index++) {
    db.upsertTrackTags(`mood-${index}`, { moods: ['calm'], energy: 'high', source: 'manual' });
  }
  const next = buildPickerTools();
  const tool = next.tools.tracksByMood;
  assert.ok(tool?.execute);
  const softened = await tool.execute({ mood: 'calm', energy: 'low' }, {
    toolCallId: 'new-mood-cache-test', messages: [], context: undefined,
  });
  assert.equal(Array.isArray(softened), true);
  assert.equal(next.seen.size, 8);
  assert.ok(candidatesSchema.parse(softened).every(track => track.energy === 'high'));
  const higher = await runMood(next.tools, 'high');
  assert.equal(higher.length, 8);
  assert.ok(higher.every(track => track.energy === 'high'));
});
