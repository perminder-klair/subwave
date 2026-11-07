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

const db = await import('../src/music/library-db.js');
const settings = await import('../src/settings.js');
const policy = await import('../src/music/original-year-policy.js');
const { lookupOriginalYear } = await import('../src/music/musicbrainz.js');
const { lookupDiscogsYear } = await import('../src/music/discogs.js');
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
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found' });
  reply(DG, dgHits({ type: 'release', title: 'Wendy Rene - Future Reissue', year: '2030' }));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'not-found' }, 'a year after the file\'s own never answers');
});

test('Discogs: a rejected token is an error; a 429 is asked once more', async () => {
  process.env.DISCOGS_TOKEN = 'bad';
  reply(DG, { status: 401, body: { message: 'You must authenticate to access this resource.' } });
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'error', reason: 'Discogs HTTP 401' });
  reply(DG, { status: 429, ...now }, dgHits({ type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' }));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'found', year: 1964, source: 'discogs' });
  reply(DG, new Error('socket hang up'));
  assert.deepEqual(await lookupDiscogsYear(track), { kind: 'error', reason: 'socket hang up' });
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
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'not-found' });
  assert.equal(calls(DG).length, 0);
});

test('a MusicBrainz miss falls back to Discogs', async () => {
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(MB, mbNone, mbNone);
  reply(DG, dgHits({ type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' }));
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'found', year: 1964, source: 'discogs' });
  reply(MB, mbNone, mbNone);
  reply(DG, dgHits());
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'not-found' }, 'both answered, neither knows');
});

test('an unanswered source is never a miss: the result is an error unless the other one finds it', async () => {
  process.env.DISCOGS_TOKEN = 'tok-123';
  reply(MB, mbNone, mbNone);
  reply(DG, { status: 500 });
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'error', reason: 'Discogs HTTP 500' });
  reply(MB, { status: 503, ...now }, { status: 503, ...now });
  reply(DG, dgHits());
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'error', reason: 'MusicBrainz HTTP 503' });
  reply(MB, { status: 503, ...now }, { status: 503, ...now });
  reply(DG, dgHits({ type: 'master', title: 'Wendy Rene - After Laughter', year: '1964' }));
  assert.deepEqual(await lookupOriginalYearAnySource(track), { kind: 'found', year: 1964, source: 'discogs' });
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
