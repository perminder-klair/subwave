// The year facet's sources: MusicBrainz first, Discogs as the fallback when a
// token is configured, one retry on a rate-limit answer, and what each
// combination of answers stores. The facet rules themselves are in
// scripts/original-year-facet.test.ts.

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './test-utils/temp-dir.js';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-year-sources-'));
process.env.STATE_DIR = stateDir;
delete process.env.DISCOGS_TOKEN;
// requireAdmin is a no-op without these, so the settings route mounts bare.
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const db = await import('../src/music/library-db.js');
const settings = await import('../src/settings.js');
const policy = await import('../src/music/original-year-policy.js');
const { lookupOriginalYear } = await import('../src/music/musicbrainz.js');
const { lookupDiscogsYear, forgetDiscogsRefusal, discogsRefused } = await import('../src/music/discogs.js');
const { lookupOriginalYearAnySource } = await import('../src/music/original-year.js');
const { SECRET_ENV_KEYS } = await import('../src/setup/secrets.js');
await settings.load();
await db.open({ embeddingDim: 8, adoptStoredDim: true });

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  db.close?.();
  await removeTempDir(stateDir);
});

// A scripted fake network: each host answers from its own queue, and every
// request is recorded.
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
const queues: Record<string, Reply[]> = {};
const seen: Array<{ host: string; url: URL; headers: Headers }> = [];
const reply = (host: string, ...r: Reply[]) => { (queues[host] ??= []).push(...r); };
const calls = (host: string) => seen.filter((s) => s.host === host);
const MB = 'musicbrainz.org';
const DG = 'api.discogs.com';
beforeEach(() => {
  for (const k of Object.keys(queues)) delete queues[k];
  seen.length = 0;
  delete process.env.DISCOGS_TOKEN;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    seen.push({ host: url.hostname, url, headers: new Headers(init?.headers) });
    const r = queues[url.hostname]?.shift();
    if (!r) throw new Error(`unexpected request to ${url.hostname}`);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
});

const track = { title: 'After Laughter (Comes Tears)', artist: 'Wendy Rene', year: 2012 };
const mbHit = (year: string) => ({
  status: 200,
  body: { recordings: [{ score: 100, title: track.title, 'first-release-date': year, 'artist-credit': [{ name: track.artist }] }] },
});
const mbNone = { status: 200, body: { recordings: [] } };
const dgHits = (...results: Array<{ type?: string; title: string; year?: string }>) => ({ status: 200, body: { results } });
const now = { headers: { 'Retry-After': '0' } };

// ── retry on a rate-limit answer ──────────────────────────────────────────

test('only a rate-limit answer is retried, after Retry-After capped at 10 s', () => {
  assert.equal(policy.retryWaitMs(503, null), 2000, 'no header: a short default');
  assert.equal(policy.retryWaitMs(429, '3'), 3000);
  assert.equal(policy.retryWaitMs(503, '0'), 0);
  assert.equal(policy.retryWaitMs(503, '600'), 10_000, 'never parks the pass for long');
  assert.equal(policy.retryWaitMs(503, 'soon'), 2000, 'an unreadable header is the default');
  for (const s of [200, 400, 401, 404, 500, 502]) assert.equal(policy.retryWaitMs(s, '0'), null, String(s));
});

test('MusicBrainz: a 503 is asked once more, and answers if the retry does', async () => {
  reply(MB, { status: 503, ...now }, mbHit('1964-01-01'));
  assert.deepEqual(await lookupOriginalYear({ ...track, mbid: null }), { kind: 'found', year: 1964 });
  assert.equal(calls(MB).length, 2);
});

test('MusicBrainz: two 503s in a row are an error, never a miss', async () => {
  reply(MB, { status: 503, ...now }, { status: 503, ...now });
  assert.deepEqual(await lookupOriginalYear({ title: 'Plain', artist: 'Plain', year: 2012 }), { kind: 'error', reason: 'MusicBrainz HTTP 503' });
  assert.equal(calls(MB).length, 2, 'one retry, not a loop');
});

// ── the Discogs client ────────────────────────────────────────────────────

test('Discogs: without a token nothing is asked', async () => {
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found' });
  assert.equal(calls(DG).length, 0);
});

test('Discogs: the earliest year among the artist\'s own releases of the track', async () => {
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(DG, dgHits(
    { type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' },
    { type: 'release', title: 'Various - Soul Sides', year: '1960' },
    { type: 'master', title: 'Wendy Rene - The Complete Wendy Rene', year: '2012' },
    { type: 'release', title: 'Wendy Rene - Bootleg', year: '' },
    { type: 'release', title: 'Wendy Rene - Future Reissue', year: '2030' },
    { type: 'artist', title: 'Wendy Rene', year: '1950' },
  ));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'found', year: 1964, source: 'discogs' });
  const [req] = calls(DG);
  assert.equal(req.url.pathname, '/database/search');
  assert.equal(req.url.searchParams.get('artist'), 'Wendy Rene');
  assert.equal(req.url.searchParams.get('track'), 'After Laughter', 'the title is searched without its noise');
  assert.equal(req.url.searchParams.get('token'), null, 'the token is never in the URL');
  assert.equal(req.headers.get('authorization'), 'Discogs token=tok-123');
  assert.match(req.headers.get('user-agent') ?? '', /subwave/);
});

test('Discogs: another artist\'s release never answers', async () => {
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(DG, dgHits({ type: 'release', title: 'Various - Soul Sides', year: '1960' }, { type: 'master', title: 'Wendy Renee Smith - Other', year: '1970' }));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found', source: 'discogs' });
  reply(DG, dgHits({ type: 'release', title: 'Wendy Rene - Future Reissue', year: '2030' }));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found', source: 'discogs' }, 'a year after the file\'s own never answers');
});

test('Discogs: a refused token takes no part, and is skipped from then on without a request', async (tc) => {
  const warnings: string[] = [];
  tc.mock.method(console, 'warn', (msg: string) => { warnings.push(msg); });
  forgetDiscogsRefusal();
  process.env.DISCOGS_TOKEN = 'bad';
  reply(DG, { status: 401, body: { message: 'You must authenticate to access this resource.' } });
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found' }, 'refused: Discogs took no part');
  assert.equal(calls(DG).length, 1);
  assert.equal(discogsRefused(), true);
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found' });
  assert.equal(calls(DG).length, 1, 'the refused token is never sent again');
  assert.ok(Date.now() - t0 < 500, `skipped lookups wait no throttle gap (${Date.now() - t0} ms)`);
  assert.equal(warnings.length, 1, 'logged once, not once per track');
  assert.match(warnings[0], /refused \(HTTP 401\): Discogs is skipped from now on/);
  // A different token is asked again; the refused one stays skipped.
  process.env.DISCOGS_TOKEN = 'good';
  assert.equal(discogsRefused(), false);
  reply(DG, dgHits({ type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' }));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'found', year: 1964, source: 'discogs' });
  process.env.DISCOGS_TOKEN = 'bad';
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found' });
  assert.equal(calls(DG).length, 2, 'switching back to the refused token sends nothing');
  // Forgetting the refusal (a save) asks again; a 403 is a refusal too.
  forgetDiscogsRefusal();
  reply(DG, { status: 403 });
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found' });
  assert.equal(calls(DG).length, 3);
  assert.equal(discogsRefused(), true);
  assert.match(warnings[1], /HTTP 403/);
  forgetDiscogsRefusal();
});

test('Discogs: lookups already queued when the refusal lands send nothing', async (tc) => {
  tc.mock.method(console, 'warn', () => {});
  forgetDiscogsRefusal();
  process.env.DISCOGS_TOKEN = 'bad';
  reply(DG, { status: 401 });
  // The year pool runs lookups concurrently: three wait on the throttle
  // while the first one is refused.
  const answers = await Promise.all([1, 2, 3, 4].map(() => lookupDiscogsYear(track)));
  assert.equal(calls(DG).length, 1, 'the queued lookups never send the refused token');
  for (const a of answers) assert.deepEqual(a, { kind: 'not-found' });
  forgetDiscogsRefusal();
});

test('Discogs: a 429 is asked once more; a network error is an error', async () => {
  forgetDiscogsRefusal();
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(DG, { status: 429, ...now }, dgHits({ type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' }));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'found', year: 1964, source: 'discogs' });
  reply(DG, new Error('socket hang up'));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'error', reason: 'socket hang up', source: 'discogs' });
});

test('a rate-limit retry counts as the latest request: the next one keeps the 1 req/s gap', async () => {
  const at: number[] = [];
  const fake = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { at.push(Date.now()); return fake(input, init); }) as typeof fetch;
  reply(MB, { status: 503, headers: { 'Retry-After': '1' } }, mbHit('1964'));
  assert.equal((await lookupOriginalYear(track)).kind, 'found');
  reply(MB, mbHit('1964'));
  assert.equal((await lookupOriginalYear(track)).kind, 'found');
  assert.equal(at.length, 3);
  assert.ok(at[2] - at[1] >= 1000, `the request after a retry waited ${at[2] - at[1]} ms`);
});

// ── the two together ──────────────────────────────────────────────────────

test('a MusicBrainz year is final: Discogs is not asked', async () => {
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(MB, mbHit('1964'));
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'found', year: 1964, source: 'musicbrainz' });
  assert.equal(calls(DG).length, 0);
});

test('a MusicBrainz miss without a token stays a miss', async () => {
  reply(MB, mbNone, mbNone);
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'not-found', source: 'musicbrainz' });
  assert.equal(calls(DG).length, 0);
});

test('a MusicBrainz miss falls back to Discogs', async () => {
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(MB, mbNone, mbNone);
  reply(DG, dgHits({ type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' }));
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'found', year: 1964, source: 'discogs' });
  reply(MB, mbNone, mbNone);
  reply(DG, dgHits());
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'not-found', source: 'discogs' }, 'both answered, neither knows: the last asked');
});

test('an unanswered Discogs after a MusicBrainz miss is an error, never a miss', async () => {
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(MB, mbNone, mbNone);
  reply(DG, { status: 500 });
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'error', reason: 'Discogs HTTP 500', source: 'discogs' });
});

test('a MusicBrainz error is the answer: Discogs is not asked, even when it would know', async () => {
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(MB, { status: 503, ...now }, { status: 503, ...now });
  reply(DG, dgHits({ type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' }));
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'error', reason: 'MusicBrainz HTTP 503', source: 'musicbrainz' },
    'a Discogs year is kept for good, so it must not stand in for a MusicBrainz blip');
  assert.equal(calls(DG).length, 0, 'Discogs is asked only after a real MusicBrainz miss');
});

test('a refused Discogs token keeps MusicBrainz\'s answer: a miss stays a miss, an error stays an error', async () => {
  forgetDiscogsRefusal();
  process.env.DISCOGS_TOKEN = 'typo';
  reply(MB, mbNone, mbNone);
  reply(DG, { status: 401 });
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'not-found', source: 'musicbrainz' }, 'a settled miss is not turned into a failure');
  reply(MB, { status: 503, ...now }, { status: 503, ...now });
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'error', reason: 'MusicBrainz HTTP 503', source: 'musicbrainz' });
});

// ── what is stored ────────────────────────────────────────────────────────

const yearRow = (id: string) => db.requireDb()
  .prepare(`SELECT status, reason, attempts FROM track_facet_status WHERE track_id = ? AND facet = 'year'`)
  .get(id) as { status: string; reason: string | null; attempts: number } | undefined;
const suspect = (id: string) =>
  db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'Wendy Rene', album: 'Anthology', year: 2012, eraUntrusted: true });

test('a Discogs year is stored with its source', () => {
  suspect('dg');
  db.recordOriginalYearOutcome('dg', { kind: 'found', year: 1964, source: 'discogs' });
  const t = db.getTrack('dg')!;
  assert.equal(t.originalYear, 1964);
  assert.equal(t.originalYearSource, 'discogs');
  assert.deepEqual({ ...yearRow('dg') }, { status: 'ok', reason: 'discogs', attempts: 0 });
});

test('a failed or missed lookup row names the source that gave that answer', () => {
  const source = (id: string) => (db.requireDb()
    .prepare(`SELECT status, source FROM track_facet_status WHERE track_id = ? AND facet = 'year'`)
    .get(id) as { status: string; source: string | null } | undefined);
  suspect('src-fail');
  db.recordOriginalYearOutcome('src-fail', { kind: 'error', reason: 'Discogs HTTP 500', source: 'discogs' });
  assert.deepEqual({ ...source('src-fail') }, { status: 'failed', source: 'discogs' });
  db.recordOriginalYearOutcome('src-fail', { kind: 'error', reason: 'MusicBrainz HTTP 503', source: 'musicbrainz' });
  assert.deepEqual({ ...source('src-fail') }, { status: 'failed', source: 'musicbrainz' }, 'the latest failure, not the first');
  suspect('src-miss');
  db.recordOriginalYearOutcome('src-miss', { kind: 'not-found', source: 'musicbrainz' });
  db.recordOriginalYearOutcome('src-miss', { kind: 'error', reason: 'Discogs HTTP 502', source: 'discogs' });
  assert.deepEqual({ ...source('src-miss') }, { status: 'failed', source: 'discogs' }, 'a withdrawn miss names the host that failed');
  db.recordOriginalYearOutcome('src-miss', { kind: 'not-found', source: 'discogs' });
  assert.deepEqual({ ...source('src-miss') }, { status: 'unmeasurable', source: 'discogs' });
});

test('the walk and an id adoption keep a Discogs year, as they keep a MusicBrainz or manual one', () => {
  assert.deepEqual([...policy.KEPT_YEAR_SOURCES].sort(), ['discogs', 'manual', 'musicbrainz']);
  assert.equal(policy.yearSourceKept('album-tag'), false);
  assert.equal(policy.yearSourceKept(null), false);
  suspect('dg-walked');
  db.recordOriginalYearOutcome('dg-walked', { kind: 'found', year: 1964, source: 'discogs' });
  // The next walk brings the album tag's year: it must not replace the lookup's.
  db.upsertTrackMeta('dg-walked', { title: 'Song dg-walked', artist: 'Wendy Rene', album: 'Anthology', year: 2012, originalYear: 1999, eraUntrusted: true });
  const t = db.getTrack('dg-walked')!;
  assert.equal(t.originalYear, 1964);
  assert.equal(t.originalYearSource, 'discogs');
});

test('an error re-asking a not-found turns it into a failed lookup, retried on the schedule', () => {
  suspect('reasked');
  db.recordOriginalYearOutcome('reasked', { kind: 'not-found' });
  db.recordOriginalYearOutcome('reasked', { kind: 'error', reason: 'MusicBrainz HTTP 503' });
  assert.equal(db.getTrack('reasked')!.originalYearCheckedAt, null, 'the old answer is no longer the last word');
  assert.deepEqual({ ...yearRow('reasked') }, { status: 'failed', reason: 'MusicBrainz HTTP 503', attempts: 1 });
  assert.ok(!db.yearLookupDueIds(Date.now()).includes('reasked'), 'not before an hour');
  assert.ok(db.yearLookupDueIds(Date.now() + 60 * 60_000).includes('reasked'));
});

test('an error never touches a resolved or manual year', () => {
  suspect('known');
  db.recordOriginalYearOutcome('known', { kind: 'found', year: 1966 });
  db.recordOriginalYearOutcome('known', { kind: 'error', reason: 'timeout' });
  assert.equal(db.getTrack('known')!.originalYear, 1966);
  assert.ok(db.getTrack('known')!.originalYearCheckedAt, 'a resolved year keeps its stamp');
  assert.equal(yearRow('known')!.status, 'ok');
  suspect('pinned');
  db.setManualOriginalYear('pinned', 1959);
  db.recordOriginalYearOutcome('pinned', { kind: 'error', reason: 'timeout' });
  assert.ok(db.getTrack('pinned')!.originalYearCheckedAt, 'a manual stamp is never cleared');
  assert.equal(yearRow('pinned')!.reason, 'manual');
});

test('the Discogs token is a stored secret', () => {
  assert.ok((SECRET_ENV_KEYS as readonly string[]).includes('DISCOGS_TOKEN'));
});

test('saving a Discogs token from the settings asks Discogs again, even a token it refused', async () => {
  const express = (await import('express')).default;
  const { listen } = await import('./test-utils/http.js');
  const { router } = await import('../src/routes/settings/core.js');
  const app = express();
  app.use(express.json());
  app.use(router);
  const { server, url } = await listen(app);
  try {
    forgetDiscogsRefusal();
    process.env.DISCOGS_TOKEN = 'bad';
    reply(DG, { status: 401 });
    await lookupDiscogsYear(track);
    assert.equal(discogsRefused(), true);
    const realFetchForRoute = globalThis.fetch;
    globalThis.fetch = realFetch;
    try {
      const res = await fetch(`${url}/settings/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ DISCOGS_TOKEN: 'bad' }),
      });
      assert.deepEqual(((await res.json()) as { saved: string[] }).saved, ['DISCOGS_TOKEN']);
    } finally {
      globalThis.fetch = realFetchForRoute;
    }
    assert.equal(discogsRefused(), false, 'the save cleared the refusal');
    reply(DG, dgHits({ type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' }));
    assert.deepEqual(await lookupDiscogsYear(track), { kind: 'found', year: 1964, source: 'discogs' });
  } finally {
    server.close();
  }
});
