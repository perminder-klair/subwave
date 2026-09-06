// Pins GET /similar-tracks — the listener-facing CLAP "sounds like this"
// lookup (#1575) — and the two things about it that are easy to break without
// noticing on a running station:
//
//  - THE GATE FAILS CLOSED. It is the STATION password, not the admin one, so
//    the endpoint is open on a public station (that is the point — an
//    operator's call-in agent shouldn't need the admin credential) and shut on
//    a private one. Reusing listenerAuthDecision here would fail OPEN with
//    listenerAuth off, which is the exact mistake stationAuthDecision exists to
//    prevent, so the route's stack is asserted too — a middleware quietly
//    dropped from the route is a private library published to the internet.
//  - AN EMPTY RESULT CARRIES A REASON. A lean analyzer, a library mid-analysis
//    and an unknown seed all return zero tracks; collapsing them into a bare []
//    leaves an API consumer unable to tell "try again later" from "your id is
//    wrong".
//
// The public row shape is pinned by its EXACT key set, not by spot checks: the
// issue's constraint is "never widen it", and a widening is an added key.
//
// STATE_DIR is redirected before the first import, like talk-air.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-similar-'));

const {
  SIMILAR_LIMIT_DEFAULT,
  SIMILAR_LIMIT_MAX,
  parseSimilarLimit,
  publicSimilarTrack,
  soundKnnWidth,
  similarTracksOutcome,
} = await import('../src/util/similar-tracks.js');
const { stationAuthCandidate, stationAuthDecision } = await import('../src/util/listener-auth.js');

const PW = 'hunter2-correct-horse';

// --- the empty-with-a-reason contract -------------------------------------

test('every empty result names its own cause, widest first', () => {
  const base = { audioIndexSize: 500, libraryTotal: 900, seedFound: true, seedHasVector: true, neighbourCount: 8 };

  assert.equal(similarTracksOutcome(base).reason, 'ok');
  assert.equal(similarTracksOutcome(base).message, null, 'a good answer says nothing extra');

  // A station on the lean analyzer is told THAT, not "your seed isn't
  // analysed" — which would be true of every track it owns and points the
  // operator at the wrong fix.
  const lean = similarTracksOutcome({ ...base, audioIndexSize: 0, seedFound: false, seedHasVector: false, neighbourCount: 0 });
  assert.equal(lean.reason, 'no-audio-index');
  assert.match(String(lean.message), /heavy analyzer/);

  const unknown = similarTracksOutcome({ ...base, seedFound: false, seedHasVector: false, neighbourCount: 0 });
  assert.equal(unknown.reason, 'seed-not-found');

  const unanalysed = similarTracksOutcome({ ...base, seedHasVector: false, neighbourCount: 0 });
  assert.equal(unanalysed.reason, 'seed-not-analysed');
  assert.match(String(unanalysed.message), /500 of 900/, 'coverage is quoted so the caller can judge "try later"');

  // The seed IS analysed and the KNN ran — everything it found was blocked or
  // filtered. Distinct from "not analysed": retrying later will not help.
  const blocked = similarTracksOutcome({ ...base, neighbourCount: 0 });
  assert.equal(blocked.reason, 'no-neighbours');
});

// --- limit handling -------------------------------------------------------

test('limit clamps rather than trusting the caller', () => {
  assert.equal(parseSimilarLimit(undefined), SIMILAR_LIMIT_DEFAULT);
  assert.equal(parseSimilarLimit(''), SIMILAR_LIMIT_DEFAULT);
  assert.equal(parseSimilarLimit('not a number'), SIMILAR_LIMIT_DEFAULT);
  assert.equal(parseSimilarLimit('7'), 7);
  assert.equal(parseSimilarLimit(0), 1, 'zero would return nothing at all');
  assert.equal(parseSimilarLimit(-5), 1);
  assert.equal(parseSimilarLimit(9999), SIMILAR_LIMIT_MAX);

  // The KNN is deliberately WIDER than the page: the archive filter and the
  // blocklist cut rows after the search, so a narrow pull returns short pages.
  assert.equal(soundKnnWidth(12), 60);
  assert.equal(soundKnnWidth(50), 100);
});

// --- the public row shape -------------------------------------------------

const SEED_ROW = {
  id: 'trk-1',
  title: 'Cirrus',
  artist: 'Bonobo',
  album: 'The North Borders',
  year: 2019,
  originalYear: 2013,
  yearUntrusted: false,
  genres: ['Electronic', 'Downtempo'],
  genre: 'Electronic',
  moods: ['hypnotic'],
  audioMoods: ['nocturnal'],
  energy: 'medium',
  durationSec: 292,
  bpm: 112,
  musicalKey: 'Am',
  vocalRanges: [],
  _similarity: 0.87,
  // Admin-only fields that must NOT survive the mapping.
  source: 'llm',
  originalYearSource: 'musicbrainz',
  isCompilation: false,
  lastfmTags: ['chillout'],
  loudnessLufs: -9.4,
};

test('the published row is a fixed, non-widening subset', () => {
  const row = publicSimilarTrack(SEED_ROW as never);
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      'album', 'artist', 'bpm', 'duration', 'energy', 'genre', 'genres', 'id',
      'instrumental', 'moods', 'musicalKey', 'similarity', 'title', 'year',
    ],
    'adding a key here publishes it to the internet — do it deliberately',
  );
});

test('the CLAP-derived audioMoods stay an admin surface', () => {
  // The seed row carries audioMoods and /library/browse publishes them behind
  // requireAdmin. This route is reachable with NO credential on a public
  // station, so it is not the place they first go public — the issue's
  // constraint is "never widen it", and the widest reading of that is the one
  // that can't leak.
  assert.equal('audioMoods' in publicSimilarTrack(SEED_ROW as never), false);
});

test('the year is the ERA year, never the raw release year', () => {
  // #1418: a reissue's own date is untrusted, and this is a listener-facing
  // surface, so it resolves through show-filter.resolveEraYear like every
  // other one.
  assert.equal(publicSimilarTrack(SEED_ROW as never).year, 2013, 'originalYear wins');
  assert.equal(
    publicSimilarTrack({ ...SEED_ROW, originalYear: null, yearUntrusted: true } as never).year,
    null,
    'an untrusted year is unknown, not a reissue date presented as fact',
  );
  assert.equal(
    publicSimilarTrack({ ...SEED_ROW, originalYear: null, yearUntrusted: false } as never).year,
    2019,
    'a trusted plain year still counts',
  );
});

test('multi-value genres travel as both the list and the joined scalar', () => {
  const row = publicSimilarTrack(SEED_ROW as never);
  assert.deepEqual(row.genres, ['Electronic', 'Downtempo']);
  assert.equal(row.genre, 'Electronic, Downtempo', 'same pairing /now-playing publishes');

  const untagged = publicSimilarTrack({ ...SEED_ROW, genres: [], genre: 'Jazz' } as never);
  assert.equal(untagged.genre, 'Jazz', 'the scalar column is the fallback, not the source');
});

test('instrumental separates "analysed, no vocals" from "never analysed"', () => {
  assert.equal(publicSimilarTrack(SEED_ROW as never).instrumental, true);
  assert.equal(publicSimilarTrack({ ...SEED_ROW, vocalRanges: [{}] } as never).instrumental, false);
  assert.equal(publicSimilarTrack({ ...SEED_ROW, vocalRanges: null } as never).instrumental, null);
});

test('a missing similarity is null, never 0 — 0 is a real cosine', () => {
  assert.equal(publicSimilarTrack(SEED_ROW as never).similarity, 0.87);
  assert.equal(publicSimilarTrack({ ...SEED_ROW, _similarity: undefined } as never).similarity, null);
  assert.equal(publicSimilarTrack({ ...SEED_ROW, _similarity: 0 } as never).similarity, 0);
});

// --- where the station password rides on a GET ----------------------------

test('the credential is read from the header, a Bearer token, or ?auth=', () => {
  assert.equal(stationAuthCandidate({ headerToken: PW }), PW);
  assert.equal(stationAuthCandidate({ authorization: `Bearer ${PW}` }), PW);
  assert.equal(stationAuthCandidate({ authorization: `bearer ${PW}` }), PW, 'scheme is case-insensitive');
  assert.equal(stationAuthCandidate({ query: PW }), PW);

  assert.equal(stationAuthCandidate({ headerToken: PW, query: 'wrong' }), PW, 'the explicit header wins');
  assert.equal(stationAuthCandidate({ authorization: `Bearer ${PW}`, query: 'wrong' }), PW);

  // ADMIN credentials must never be mistaken for the station password: they are
  // a different secret, and accepting them here would quietly widen the gate.
  assert.equal(stationAuthCandidate({ authorization: 'Basic dXNlcjpwYXNz' }), '', 'Basic is not a station token');

  // A repeated query param arrives as an array. Guessing which one the caller
  // meant is how a wrong password gets accepted.
  assert.equal(stationAuthCandidate({ query: [PW, 'wrong'] }), '');
  assert.equal(stationAuthCandidate({}), '');
  assert.equal(stationAuthCandidate({ headerToken: '   ' }), '', 'whitespace is not a credential');
});

// --- the gate, driven through the real middleware -------------------------

const settings = await import('../src/settings.js');
const { requireStationAuth } = await import('../src/middleware/station-auth.js');

interface FakeRes {
  code: number | null;
  body: unknown;
  headers: Record<string, string>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  setHeader(k: string, v: string): void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    code: null,
    body: undefined,
    headers: {},
    status(c) { res.code = c; return res; },
    json(b) { res.body = b; return res; },
    setHeader(k, v) { res.headers[k] = v; },
  };
  return res;
}

// Every call gets its own source address so the failure counter (shared with
// POST /station-auth, 20 per 15 min) can't leak between assertions.
let ipSeq = 0;
async function callGate(req: Record<string, unknown> = {}): Promise<{ passed: boolean; res: FakeRes }> {
  ipSeq += 1;
  const res = fakeRes();
  let passed = false;
  await requireStationAuth(
    {
      headers: { 'x-forwarded-for': `203.0.113.${ipSeq % 250}`, ...(req.headers as object || {}) },
      query: (req.query as object) || {},
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
    res as never,
    () => { passed = true; },
  );
  return { passed, res };
}

test('a public station answers with no credential at all', async () => {
  await settings.load();
  const { passed } = await callGate();
  assert.equal(passed, true, 'no lock engaged → nothing to unlock');
});

test('a private station fails CLOSED, and opens for the real password only', async () => {
  await settings.update({ privacy: { password: PW, privatePlayer: true } } as never);

  const missing = await callGate();
  assert.equal(missing.passed, false, 'no credential on a locked station is 401, not a pass');
  assert.equal(missing.res.code, 401);

  const wrong = await callGate({ headers: { 'x-station-auth': 'not-the-password' } });
  assert.equal(wrong.passed, false);
  assert.equal(wrong.res.code, 401);

  for (const req of [
    { headers: { 'x-station-auth': PW } },
    { headers: { authorization: `Bearer ${PW}` } },
    { query: { auth: PW } },
  ]) {
    const ok = await callGate(req);
    assert.equal(ok.passed, true, `the real password opens the gate via ${JSON.stringify(req)}`);
    assert.equal(ok.res.code, null, 'a pass writes no response of its own');
  }
});

test('privatePlayer OFF with listenerAuth ON still closes the gate', async () => {
  // The ASYMMETRY that makes this middleware not-listenerAuthDecision: that one
  // reads `enabled: false` and waves everything through, which here would
  // publish a private library.
  await settings.update({ privacy: { password: PW, privatePlayer: false, listenerAuth: true } } as never);
  assert.equal((await callGate()).passed, false);
  assert.equal((await callGate({ headers: { 'x-station-auth': PW } })).passed, true);

  // And the pure decision agrees, so the middleware can't be "simplified" into
  // the Icecast one without this failing.
  assert.equal(
    stationAuthDecision({ privatePlayer: false, listenerAuth: true, password: PW, candidate: 'x' }),
    false,
  );
});

test('a lock with no password on file is closed, not open', async () => {
  // settings.update refuses to persist this state, so it is built by hand —
  // a hand-edited settings.json can still produce it, and the gate must not
  // read "no password" as "no lock".
  assert.equal(
    stationAuthDecision({ privatePlayer: true, listenerAuth: false, password: '', candidate: '' }),
    false,
  );
});

// --- the failure counter is this route's own ------------------------------

test('a failing API read cannot spend the player password box\'s attempts', async () => {
  // Both surfaces use checkAuthRateLimit with the same 20-per-15-min ceiling,
  // but on separate counters. An operator's call-in agent left polling with a
  // stale password must not burn the twenty attempts a HUMAN on that address
  // needs to unlock the player — a misconfigured integration locking a
  // listener out of the station is a worse failure than the one the cap is for.
  const { checkAuthRateLimit } = await import('../src/middleware/ratelimit.js');
  const ip = '198.51.100.7';

  for (let i = 0; i < 20; i++) {
    assert.equal(checkAuthRateLimit(ip, 'station-read').ok, true, `read attempt ${i + 1} is within cap`);
  }
  const tripped = checkAuthRateLimit(ip, 'station-read');
  assert.equal(tripped.ok, false, 'the read surface still has a brute-force bound');
  assert.ok(Number(tripped.retryAfter) > 0);

  // Same IP, same instant, other surface: untouched.
  assert.equal(checkAuthRateLimit(ip, 'station-auth').ok, true, 'the password box is unaffected');

  // And the default argument is the password box, so the existing call in
  // POST /station-auth keeps its historical counter.
  assert.equal(checkAuthRateLimit('203.0.113.250').ok, true);
});

// --- the route is actually behind the gate --------------------------------

test('GET /similar-tracks is mounted with requireStationAuth in front of it', async () => {
  const { router } = await import('../src/routes/public.js');
  const layer = (router as never as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] } }[] })
    .stack.find((l) => l.route?.path === '/similar-tracks');
  assert.ok(layer?.route, 'the route exists');
  assert.equal(layer.route.methods.get, true, 'it is a GET');
  assert.ok(
    layer.route.stack.some((h) => h.name === 'requireStationAuth'),
    'the gate is in the handler chain — without it a private library is public',
  );
});
