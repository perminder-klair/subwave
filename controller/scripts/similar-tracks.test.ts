// GET /similar-tracks (#1575). Two properties: the gate fails CLOSED on the
// STATION password (not listenerAuthDecision, which fails open), and an empty
// result carries a reason. The public row shape is pinned by its exact key
// set, since a widening is an added key.

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

test('every empty result names its own cause, widest first', () => {
  const base = { audioIndexSize: 500, libraryTotal: 900, seedFound: true, seedHasVector: true, neighbourCount: 8 };

  assert.equal(similarTracksOutcome(base).reason, 'ok');
  assert.equal(similarTracksOutcome(base).message, null, 'a good answer says nothing extra');

  // A lean-analyzer station is told THAT, not "seed not analysed", which would
  // be true of every track it owns.
  const lean = similarTracksOutcome({ ...base, audioIndexSize: 0, seedFound: false, seedHasVector: false, neighbourCount: 0 });
  assert.equal(lean.reason, 'no-audio-index');
  assert.match(String(lean.message), /heavy analyzer/);

  const unknown = similarTracksOutcome({ ...base, seedFound: false, seedHasVector: false, neighbourCount: 0 });
  assert.equal(unknown.reason, 'seed-not-found');

  const unanalysed = similarTracksOutcome({ ...base, seedHasVector: false, neighbourCount: 0 });
  assert.equal(unanalysed.reason, 'seed-not-analysed');
  assert.match(String(unanalysed.message), /500 of 900/, 'coverage is quoted so the caller can judge "try later"');

  // The KNN ran and everything was blocked or filtered; retrying will not help.
  const blocked = similarTracksOutcome({ ...base, neighbourCount: 0 });
  assert.equal(blocked.reason, 'no-neighbours');
});

test('limit clamps rather than trusting the caller', () => {
  assert.equal(parseSimilarLimit(undefined), SIMILAR_LIMIT_DEFAULT);
  assert.equal(parseSimilarLimit(''), SIMILAR_LIMIT_DEFAULT);
  assert.equal(parseSimilarLimit('not a number'), SIMILAR_LIMIT_DEFAULT);
  assert.equal(parseSimilarLimit('7'), 7);
  assert.equal(parseSimilarLimit(0), 1, 'zero would return nothing at all');
  assert.equal(parseSimilarLimit(-5), 1);
  assert.equal(parseSimilarLimit(9999), SIMILAR_LIMIT_MAX);

  // The KNN is wider than the page: filters cut rows after the search.
  assert.equal(soundKnnWidth(12), 60);
  assert.equal(soundKnnWidth(50), 100);
});

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
  // /library/browse publishes audioMoods behind requireAdmin; this route is
  // reachable with no credential on a public station.
  assert.equal('audioMoods' in publicSimilarTrack(SEED_ROW as never), false);
});

test('the year is the ERA year, never the raw release year', () => {
  // #1418: resolves through show-filter.resolveEraYear like every other
  // listener-facing year.
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

test('the credential is read from the header, a Bearer token, or ?auth=', () => {
  assert.equal(stationAuthCandidate({ headerToken: PW }), PW);
  assert.equal(stationAuthCandidate({ authorization: `Bearer ${PW}` }), PW);
  assert.equal(stationAuthCandidate({ authorization: `bearer ${PW}` }), PW, 'scheme is case-insensitive');
  assert.equal(stationAuthCandidate({ query: PW }), PW);

  assert.equal(stationAuthCandidate({ headerToken: PW, query: 'wrong' }), PW, 'the explicit header wins');
  assert.equal(stationAuthCandidate({ authorization: `Bearer ${PW}`, query: 'wrong' }), PW);

  // Admin credentials are a different secret and must not open this gate.
  assert.equal(stationAuthCandidate({ authorization: 'Basic dXNlcjpwYXNz' }), '', 'Basic is not a station token');

  // A repeated query param arrives as an array; guessing which one was meant
  // is how a wrong password gets accepted.
  assert.equal(stationAuthCandidate({ query: [PW, 'wrong'] }), '');
  assert.equal(stationAuthCandidate({}), '');
  assert.equal(stationAuthCandidate({ headerToken: '   ' }), '', 'whitespace is not a credential');
});

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

// Every call gets its own source address so the failure counter can't leak
// between assertions.
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
  // listenerAuthDecision reads `enabled: false` and waves everything through,
  // which here would publish a private library.
  await settings.update({ privacy: { password: PW, privatePlayer: false, listenerAuth: true } } as never);
  assert.equal((await callGate()).passed, false);
  assert.equal((await callGate({ headers: { 'x-station-auth': PW } })).passed, true);

  // The pure decision agrees, so the middleware can't be collapsed into the
  // Icecast one without this failing.
  assert.equal(
    stationAuthDecision({ privatePlayer: false, listenerAuth: true, password: PW, candidate: 'x' }),
    false,
  );
});

test('a lock with no password on file is closed, not open', async () => {
  // update() refuses to persist this, but a hand-edited settings.json can
  // produce it; "no password" must not read as "no lock".
  assert.equal(
    stationAuthDecision({ privatePlayer: true, listenerAuth: false, password: '', candidate: '' }),
    false,
  );
});

test('a failing API read cannot spend the player password box\'s attempts', async () => {
  // Same 20-per-15-min ceiling, separate counters: a stale-password API poller
  // must not burn the attempts a human needs to unlock the player.
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

  // The default argument is the password box, so POST /station-auth keeps its
  // historical counter.
  assert.equal(checkAuthRateLimit('203.0.113.250').ok, true);
});

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
