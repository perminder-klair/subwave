// GET /similar-tracks' SEED resolution, driven against a real library.db
// (#1575). The sibling similar-tracks.test.ts pins the pure decisions and the
// gate; this file exists for the one thing neither can see — what the handler
// does with actual library rows.
//
// Two properties, both of which a passing pure test would happily miss:
//
//  - THE BLOCKLIST REACHES THE SEED ECHO. The neighbours are filtered inside
//    library.tracksLikeThisAudio's rejectBlocked chokepoint, but the seed is
//    resolved separately — by id, or by free text — and both library.get() and
//    library.filter() are blocklist-blind. Without the isBlocked() call in the
//    route's seedRowFor, a never-play track's id/title/artist comes back in
//    `seed`, and on a public station `q` turns that into an unauthenticated
//    way to look one up by name. The blocklist is absolute.
//  - THE COVERAGE SENTENCE COUNTS THE WHOLE MIRROR. `stats().total` counts
//    only tracks the TAGGER has reached, while `withAudioEmbedding` counts
//    every CLAP vector the analyzer wrote — on a station where analysis has run
//    ahead of tagging the numerator exceeds the denominator and the message
//    reads "covers 3 of 2 tracks".
//
// STATE_DIR is redirected before the first import, like blocklist-album-id.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-similar-seed-'));

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const blocklist = await import('../src/music/blocklist.js');
const { router } = await import('../src/routes/public.js');

await library.load();
await blocklist.load();

// Three tagged tracks sharing a searchable word, so `q` has to choose between
// them, plus one mirror-only row the tagger has never reached.
const TRACKS = [
  { id: 'clean-1', title: 'Aurora Drift', artist: 'Bonobo', album: 'Migration' },
  { id: 'blocked-1', title: 'Aurora Burn', artist: 'Banned Act', album: 'Nope' },
  { id: 'clean-2', title: 'Northern Lights', artist: 'Jon Hopkins', album: 'Immunity' },
];
for (const t of TRACKS) {
  db.upsertTrackMeta(t.id, { ...t, albumId: `alb-${t.id}`, artistId: `art-${t.id}` });
  db.upsertTrackTags(t.id, { moods: ['nocturnal'], energy: 'medium', source: 'manual' });
}
// Mirror-only: metadata walked, never tagged. Counted by mirrorTotal, not total.
db.upsertTrackMeta('untagged-1', { title: 'Not Yet Tagged', artist: 'Someone' });

// A CLAP vector on each tagged track, so the audio index is non-empty and the
// seed paths can reach 'ok' / 'seed-not-analysed' rather than stopping at
// 'no-audio-index'. Distinct vectors so the KNN has somewhere to go.
const DIM = 512;
TRACKS.forEach((t, i) => {
  const v = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) v[d] = Math.sin((d + 1) * (i + 1) * 0.01);
  db.upsertTrackAudioVector(t.id, v);
});

await blocklist.add({ type: 'track', id: 'blocked-1', name: 'Aurora Burn' });

// --- drive the real handler -----------------------------------------------

interface Answer {
  code: number | null;
  body: any;
}

// The route's own handler, taken from the mounted stack (skipping
// requireStationAuth, which the sibling file pins on its own).
const layer = (router as never as {
  stack: { route?: { path: string; stack: { name: string; handle: unknown }[] } }[];
}).stack.find((l) => l.route?.path === '/similar-tracks');
assert.ok(layer?.route, '/similar-tracks is mounted');
const handler = layer.route.stack.at(-1)!.handle as (req: unknown, res: unknown) => Promise<void>;

async function call(query: Record<string, string>): Promise<Answer> {
  const answer: Answer = { code: null, body: undefined };
  const res = {
    status(c: number) { answer.code = c; return res; },
    json(b: unknown) { answer.body = b; return res; },
    setHeader() {},
  };
  await handler({ query, headers: {} }, res);
  return answer;
}

// --- the blocklist reaches the seed ---------------------------------------

test('a blocked track is never echoed as the seed, by id', async () => {
  const ok = await call({ id: 'clean-1' });
  assert.equal(ok.body.seed.id, 'clean-1', 'a clean id resolves normally');

  const blocked = await call({ id: 'blocked-1' });
  assert.equal(blocked.body.seed, null, 'the never-play list outranks a direct id lookup');
  assert.equal(blocked.body.reason, 'seed-not-found');
  assert.deepEqual(blocked.body.results, []);
});

test('free text cannot be used to look a blocked track up by name', async () => {
  // "Aurora" matches both a clean track and the blocked one. The clean match
  // must answer; the blocked title/artist must not appear anywhere.
  const both = await call({ q: 'Aurora' });
  assert.equal(both.body.seed.id, 'clean-1');
  assert.equal(JSON.stringify(both.body).includes('Aurora Burn'), false);
  assert.equal(JSON.stringify(both.body).includes('Banned Act'), false);
});

test('free text matching ONLY a blocked track finds nothing', async () => {
  const only = await call({ q: 'Banned Act' });
  assert.equal(only.body.seed, null);
  assert.equal(only.body.reason, 'seed-not-found');
});

test('a blocked track is not returned as a neighbour either', async () => {
  const res = await call({ id: 'clean-1', limit: '50' });
  const ids = res.body.results.map((r: { id: string }) => r.id);
  assert.equal(ids.includes('blocked-1'), false, 'rejectBlocked runs inside the KNN');
  assert.equal(ids.includes('clean-1'), false, 'the seed excludes itself');
});

// --- the coverage sentence ------------------------------------------------

test('coverage counts the whole mirror, not just the tagged rows', async () => {
  // 3 audio vectors; 3 tagged rows + 1 mirror-only row = 4 in the mirror.
  // Against `total` this would read "covers 3 of 3" while a track is missing;
  // against mirrorTotal it reads honestly, and can never invert.
  const stats = library.stats();
  assert.equal(stats.withAudioEmbedding, 3);
  assert.equal(stats.total, 3, 'tagged only');
  assert.equal(stats.mirrorTotal, 4, 'tagged + walked');

  const res = await call({ id: 'untagged-1' });
  assert.equal(res.body.reason, 'seed-not-analysed', 'in the mirror, but no CLAP vector');
  assert.match(String(res.body.message), /3 of 4 tracks/);
});

// --- the shape the route actually emits -----------------------------------

test('a neighbour row carries the public subset and no admin internals', async () => {
  const res = await call({ id: 'clean-1' });
  assert.ok(res.body.results.length > 0, 'the KNN found something');
  const row = res.body.results[0];
  for (const forbidden of ['source', 'originalYearSource', 'eraUntrusted', 'isCompilation',
    'yearUntrusted', 'loudnessLufs', 'audioMoods', 'blockedBy', 'lastfmTags']) {
    assert.equal(forbidden in row, false, `${forbidden} must not reach a listener-facing row`);
  }
  assert.equal(res.body.reason, 'ok');
  assert.equal(res.body.message, null);
});

test('neither id nor q is a 400, not an empty answer', async () => {
  const res = await call({});
  assert.equal(res.code, 400);
});
