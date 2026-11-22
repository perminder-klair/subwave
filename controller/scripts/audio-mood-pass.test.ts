// Pins the zero-shot pass end to end on audio moods, byte for byte. The pass is
// shared with the sound descriptors (music/audio-zero-shot.ts), so these digests
// are the proof that sharing it changed nothing: they were taken from the pass as
// it stood before descriptors existed. A digest moving here means mood labels or
// scores moved on someone's library.
//
// A real SQLite DB and a stub analyzer sidecar. The vocabulary is set in the
// fixture, so editing the shipped moods does not move the digests.
// Run: `npm test -- audio-mood-pass`.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-mood-pass-'));
process.env.STATE_DIR = stateDir;
writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
  moods: [
    { name: 'energetic', clapPrompt: 'high-energy music' },
    { name: 'calm', clapPrompt: 'calm music' },
    { name: 'night', clapPrompt: 'late-night music' },
    { name: 'rainy', clapPrompt: 'music for a rainy day' },
    { name: 'festival', clapPrompt: '' },
  ],
}));

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

let towerCalls = 0;
const server = createServer(async (req, res) => {
  const json = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') return json(200, { ok: true, engines: ['analyze'], analyze_text_capable: true });
  if (req.url === '/embed-text') {
    towerCalls += 1;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const { texts } = JSON.parse(Buffer.concat(chunks).toString()) as { texts: string[] };
    return json(200, { ok: true, embeddings: texts.map(seededVector) });
  }
  json(404, {});
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.ANALYZE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const db = await import('../src/music/library-db.js');
const settings = await import('../src/settings.js');
const { runAudioMoodPass } = await import('../src/music/audio-moods.js');
await settings.load();
await db.open({ embeddingDim: 8, adoptStoredDim: true });

after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTempDir(stateDir);
});

function addTracks(from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const id = `t${String(i).padStart(4, '0')}`;
    db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 200 });
    db.upsertTrackAudioVector(id, seededVector(id));
  }
}

const digest = () => {
  const rows = db.requireDb()
    .prepare('SELECT id, audio_moods, audio_mood_scores_json FROM tracks ORDER BY id')
    .all();
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 24);
};

// The golden values, taken on the base commit. See the header.
const UNDER_FLOOR = '4ee1c6d62c4d93df70599629';
const OVER_FLOOR = 'cc32f404fbb1c1f214c97310';
const INCREMENTAL = '5bf332e79c926f9d2da5e71d';
const RELABELLED = '338dd9a4bbca525bff82032f';
const RESCORED = '338dd9a4bbca525bff82032f';

test('under the floor: raw selection, stamped uncalibrated', async () => {
  addTracks(0, 150);
  const stats = await runAudioMoodPass();
  assert.deepEqual(stats, { scored: 150, scope: 150, skipped: null, relabelled: 150, calibrated: false });
  assert.match(db.getAudioMoodVocabHash() ?? '', /^[0-9a-f]{16}:0$/);
  assert.equal(digest(), UNDER_FLOOR);
});

test('crossing the floor recalibrates the tracks that were labelled raw', async () => {
  addTracks(150, 720);
  const stats = await runAudioMoodPass();
  assert.deepEqual(stats, { scored: 570, scope: 570, skipped: null, relabelled: 720, calibrated: true });
  assert.match(db.getAudioMoodVocabHash() ?? '', /^[0-9a-f]{16}:2$/);
  assert.equal(digest(), OVER_FLOOR);
});

test('a settled pass does nothing and never reaches the tower', async () => {
  const before = towerCalls;
  assert.deepEqual(await runAudioMoodPass(), { scored: 0, scope: 0, skipped: null });
  assert.equal(towerCalls, before);
});

test('an incremental pass labels only what it scored', async () => {
  addTracks(720, 730);
  const stats = await runAudioMoodPass();
  assert.deepEqual(stats, { scored: 10, scope: 10, skipped: null, relabelled: 10, calibrated: true });
  assert.equal(digest(), INCREMENTAL);
});

test('a calibration-version change relabels from disk without the tower', async () => {
  const hash = (db.getAudioMoodVocabHash() ?? '').split(':')[0];
  db.setAudioMoodVocabHash(`${hash}:1`);
  const before = towerCalls;
  const stats = await runAudioMoodPass();
  assert.deepEqual(stats, { scored: 0, scope: 0, skipped: null, relabelled: 730, calibrated: true });
  assert.equal(towerCalls, before);
  assert.equal(digest(), RELABELLED);
});

test('a vocabulary change re-scores the whole set', async () => {
  db.setAudioMoodVocabHash('0000000000000000:2');
  const stats = await runAudioMoodPass();
  assert.deepEqual(stats, { scored: 730, scope: 730, skipped: null, relabelled: 730, calibrated: true });
  assert.equal(digest(), RESCORED);
});
