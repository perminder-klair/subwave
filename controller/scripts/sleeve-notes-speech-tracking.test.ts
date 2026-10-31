import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = createTempDir(join(tmpdir(), 'subwave-spark-speech-'));
process.env.STATE_DIR = root;
const { open, close } = await import('../src/sleeve-notes/db.js');
const sleeves = await import('../src/sleeve-notes/link-selection.js');
const { researchStoreReadoutInDatabase } = await import('../src/sleeve-notes/research-repository.js');
const { generatePickLink, enqueuePick } = await import('../src/broadcast/dj-agent/enqueue.js');
const { queue } = await import('../src/broadcast/queue.js');
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
queue.senderBusy = true;
const now = new Date().toISOString();
const db = open();
db.prepare(`INSERT INTO sleeve_artists (id, name, created_at, updated_at) VALUES ('a', 'Example Band', ?, ?)`).run(now, now);
db.prepare(`INSERT INTO sleeve_local_attachments (local_track_id, title, artist, release_title, match_state,
  first_encountered_at, last_encountered_at, updated_at)
  VALUES ('song', 'Song', 'Example Band', 'First Record', 'unmatched', ?, ?, ?)`).run(now, now, now);
db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url,
  content_hash, content_kind, content, attribution, retrieved_at)
  VALUES ('source', 'artist', 'a', 'wikipedia', 'https://example.test', 'hash', 'bounded-text', 'Example', 'Wikipedia', ?)`).run(now);
db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording,
  source_document_id, evidence, created_at, updated_at)
  VALUES ('claim', 'artist', 'a', 'artist-stories', 'formation', 'Example Band formed in Cardiff in 1993.',
  'source', 'Example', ?, ?)`).run(now, now);
const note = { claimId: 'claim', entityType: 'artist' as const, entityId: 'a', category: 'artist-stories', topic: 'formation',
  wording: 'Example Band formed in Cardiff in 1993.', fullWording: 'Example Band formed in Cardiff in 1993.',
  shortWording: null, provider: 'wikipedia', attribution: 'Wikipedia', sourceUrl: 'https://example.test',
  relationshipKey: null, localTrackId: 'song' };
const read = (id: string) => db.prepare('SELECT * FROM sleeve_claim_uses WHERE id = ?').get(id) as Record<string, string | null>;

test('generated evidence, attempted speech, successful render and confirmed air are independent', async () => {
  const id = sleeves.recordExtendedSleeveNoteSupplied(note, 'They formed in Cardiff. Here is Song.');
  assert.equal(JSON.parse(read(id).generated_signal!).status, 'detected');
  assert.equal(read(id).tts_requested_at, null);
  sleeves.recordExtendedSleeveNoteTtsRequest(id, 'Here is Example Band with Song.', 'primary');
  assert.equal(read(id).detection_status, 'not-detected', 'trimmed speech overrides generated evidence for cooldowns');
  assert.equal(read(id).tts_rendered_at, null);
  assert.equal(read(id).aired_at, null);
  // A rescue uses its actual cue-free text and records its own completion.
  sleeves.recordExtendedSleeveNoteTtsRequest(id, 'They formed in Cardiff.', 'rescue');
  sleeves.recordExtendedSleeveNoteTtsRendered(id);
  assert.equal(read(id).tts_engine, 'rescue');
  assert.equal(read(id).tts_text, 'They formed in Cardiff.');
  assert.ok(read(id).tts_rendered_at);
  assert.equal(read(id).aired_at, null);
  const aired = Date.now();
  await queue.onSpoken({ aired: Promise.resolve(aired) } as Parameters<typeof queue.onSpoken>[0],
    { kind: 'link', channel: 'intro', text: 'They formed in Cardiff.', sleeveClaimUseId: id } as Parameters<typeof queue.onSpoken>[1]);
  assert.equal(read(id).aired_at, new Date(aired).toISOString());
  const spark = researchStoreReadoutInDatabase(db).recentSparks.find(r => r.id === id)!;
  assert.equal(spark.generatedSignal?.status, 'detected');
  assert.equal(spark.speechSignal?.status, 'detected');
  assert.equal(spark.ttsEngine, 'rescue');
});

test('a legacy/unconfirmed handoff never stamps a Spark as aired', async () => {
  const id = sleeves.recordExtendedSleeveNoteSupplied(note, 'They formed in Cardiff.');
  await queue.onSpoken({ aired: Promise.resolve(null) } as Parameters<typeof queue.onSpoken>[0],
    { kind: 'link', channel: 'intro', text: 'They formed in Cardiff.', sleeveClaimUseId: id } as Parameters<typeof queue.onSpoken>[1]);
  assert.equal(read(id).aired_at, null);
});

test('a Spark survives generation and enqueue, and a queue collision releases its reservation', async () => {
  await settings.load();
  session.start({ at: now, time: { period: 'day', vibe: 'day', mood: 'calm' }, weather: null, festival: null } as Parameters<typeof session.start>[0]);
  const song = { id: 'song', title: 'Song', artist: 'Example Band', duration: 240 };
  const generated = await generatePickLink({ current: song }, async args => {
    const id = sleeves.recordExtendedSleeveNoteSupplied(note, 'They formed in Cardiff.');
    (args.onSleeveNoteUse as (id: string) => void)(id);
    return 'They formed in Cardiff.';
  });
  let entry: Parameters<typeof queue.push>[0] | undefined;
  const fakeQueue = { push: async (item: Parameters<typeof queue.push>[0]) => { entry = item; return 1; }, log: () => {} };
  await enqueuePick(fakeQueue, song, 'test', 'agent', generated.link, null, {}, generated);
  assert.equal(entry!.sleeveClaimUseId, generated.sleeveClaimUseId);
  assert.ok(entry!.sleeveClaimUseId);
  const collision = { push: async () => -1, log: () => {} };
  await enqueuePick(collision, song, 'test', 'pool', generated.link, null, {}, generated);
  assert.ok(read(generated.sleeveClaimUseId!).released_at);
});

test.after(async () => {
  close();
  // Speech logging is best-effort and asynchronous.
  await new Promise(resolve => setTimeout(resolve, 100));
  await removeTempDir(root);
});
