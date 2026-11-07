// The year facet (MusicBrainz original year for era-suspect tracks): what each
// answer stores, how a failed lookup is retried, how the planner and the
// automatic passes pick tracks, and that an analysis failure and a lookup
// failure never count against each other.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './test-utils/temp-dir.js';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-year-facet-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const settings = await import('../src/settings.js');
const policy = await import('../src/music/original-year-policy.js');
const plan = await import('../src/music/acoustics-plan.js');
const { checkFacets } = await import('../src/music/facet-check.js');
const { lookupOriginalYear } = await import('../src/music/musicbrainz.js');
const { pendingOriginalYearIds } = await import('../src/music/tag-library/enrich.js');
await settings.load();
await db.open({ embeddingDim: 8, adoptStoredDim: true });

after(async () => {
  db.close?.();
  await removeTempDir(stateDir);
});

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

type Row = { status: string; version: number; reason: string | null; attempts: number; at: string; source: string | null };
const yearRow = (id: string) => db.requireDb()
  .prepare(`SELECT status, version, reason, attempts, at, source FROM track_facet_status WHERE track_id = ? AND facet = 'year'`)
  .get(id) as Row | undefined;
const brief = (id: string) => {
  const r = yearRow(id);
  return !r ? '-' : `${r.status}${r.reason ? ':' + r.reason : ''}${r.attempts ? '×' + r.attempts : ''}`;
};
const consistent = () => {
  const r = checkFacets();
  assert.equal(r.driftCount, 0, JSON.stringify(r.drift));
};
const suspect = (id: string, extra: Record<string, unknown> = {}) =>
  db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'Wendy Rene', album: 'Anthology', year: 2012, eraUntrusted: true, ...extra });
// Rewind the stored row's clock, as if the failure happened `ms` ago.
const age = (id: string, ms: number) => db.requireDb()
  .prepare(`UPDATE track_facet_status SET at = ? WHERE track_id = ? AND facet = 'year'`)
  .run(new Date(Date.now() - ms).toISOString(), id);

test('the retry delays are 1 h, 1 day, 7 days, then only an explicit run', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(policy.YEAR_MAX_ATTEMPTS, 3);
  assert.equal(policy.yearRetryDue(0, null, now), true);
  assert.equal(policy.yearRetryDue(1, at(HOUR - 1000), now), false);
  assert.equal(policy.yearRetryDue(1, at(HOUR), now), true);
  assert.equal(policy.yearRetryDue(2, at(DAY - 1000), now), false);
  assert.equal(policy.yearRetryDue(2, at(DAY), now), true);
  assert.equal(policy.yearRetryDue(3, at(365 * DAY), now), false, 'exhausted: never automatic');
  assert.equal(policy.yearRetryDue(1, 'not a date', now), true, 'an unreadable stamp never parks a track forever');
});

test('each kind of track gets the year row its columns say', () => {
  db.upsertTrackMeta('trusted', { title: 'Studio', artist: 'A', album: 'B', year: 1975 });
  suspect('unasked');
  suspect('resolved');
  db.setOriginalYear('resolved', 1964);
  suspect('missed');
  db.setOriginalYear('missed', null);
  suspect('manual');
  db.setManualOriginalYear('manual', 1966);
  db.upsertTrackMeta('tagged', { title: 'Tagged', artist: 'A', album: 'Comp', year: 2012, originalYear: 1971, isCompilation: true });
  assert.equal(brief('trusted'), 'ok:not-needed');
  assert.equal(brief('unasked'), '-', 'never asked: no row, so it is due');
  assert.equal(brief('resolved'), 'ok:musicbrainz');
  assert.equal(brief('missed'), 'unmeasurable:not-found');
  assert.equal(brief('manual'), 'ok:manual');
  assert.equal(brief('tagged'), 'ok:album-tag');
  const due = db.yearLookupDueIds(Date.now());
  assert.ok(due.includes('unasked'));
  for (const id of ['trusted', 'resolved', 'missed', 'manual', 'tagged']) assert.ok(!due.includes(id), id);
  consistent();
});

test('an error stamps nothing on the track and is retried on the widening schedule', () => {
  suspect('flaky');
  db.recordOriginalYearOutcome('flaky', { kind: 'error', reason: 'MusicBrainz HTTP 503' });
  assert.equal(db.getTrack('flaky')!.originalYearCheckedAt, null, 'an unanswered question is not a check');
  assert.equal(brief('flaky'), 'failed:MusicBrainz HTTP 503×1');
  assert.equal(yearRow('flaky')!.source, 'musicbrainz');
  assert.ok(!db.yearLookupDueIds(Date.now()).includes('flaky'), 'not before an hour');
  age('flaky', HOUR);
  assert.ok(db.yearLookupDueIds(Date.now()).includes('flaky'));

  db.recordOriginalYearOutcome('flaky', { kind: 'error', reason: 'timeout' });
  assert.equal(brief('flaky'), 'failed:timeout×2');
  age('flaky', DAY - HOUR);
  assert.ok(!db.yearLookupDueIds(Date.now()).includes('flaky'), 'the second retry waits a day');
  age('flaky', DAY);
  assert.ok(db.yearLookupDueIds(Date.now()).includes('flaky'));

  db.recordOriginalYearOutcome('flaky', { kind: 'error', reason: 'timeout' });
  assert.equal(brief('flaky'), 'failed:timeout×3');
  age('flaky', 30 * DAY);
  assert.ok(!db.yearLookupDueIds(Date.now()).includes('flaky'), 'three failures: off the automatic passes');
  consistent();
});

test('the failure history is a stored fact: a re-derive and a reopen keep it', async () => {
  suspect('kept');
  db.recordOriginalYearOutcome('kept', { kind: 'error', reason: 'timeout' });
  db.recordOriginalYearOutcome('kept', { kind: 'error', reason: 'timeout' });
  db.resyncAllFacets(db.requireDb());
  assert.equal(brief('kept'), 'failed:timeout×2');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(brief('kept'), 'failed:timeout×2');
  consistent();
});

test('an answer after failures ends the failure history', () => {
  suspect('recovers');
  db.recordOriginalYearOutcome('recovers', { kind: 'error', reason: 'timeout' });
  db.recordOriginalYearOutcome('recovers', { kind: 'found', year: 1968 });
  assert.equal(brief('recovers'), 'ok:musicbrainz');
  assert.equal(db.getTrack('recovers')!.originalYear, 1968);
  suspect('settles');
  db.recordOriginalYearOutcome('settles', { kind: 'error', reason: 'timeout' });
  db.recordOriginalYearOutcome('settles', { kind: 'not-found' });
  assert.equal(brief('settles'), 'unmeasurable:not-found');
  assert.ok(db.getTrack('settles')!.originalYearCheckedAt);
  consistent();
});

test('a manual year is never overwritten by a lookup', () => {
  suspect('pinned');
  db.recordOriginalYearOutcome('pinned', { kind: 'found', year: 1972 });
  assert.equal(brief('pinned'), 'ok:musicbrainz');
  db.setManualOriginalYear('pinned', 1959);
  assert.equal(brief('pinned'), 'ok:manual', 'the reason follows the columns, not the earlier answer');
  db.recordOriginalYearOutcome('pinned', { kind: 'found', year: 1972 });
  assert.equal(db.getTrack('pinned')!.originalYear, 1959);
  assert.equal(brief('pinned'), 'ok:manual');
});

test('analysis failures and lookup failures never count against each other', () => {
  db.upsertTrackMeta('audio-bad', { title: 'x', artist: 'A', album: 'B', year: 1980, duration: 100 });
  for (let i = 0; i < 3; i++) db.recordAnalysisFailure('audio-bad', 'decode failed');
  assert.equal(brief('audio-bad'), 'ok:not-needed');
  suspect('both-bad');
  db.recordAnalysisFailure('both-bad', 'decode failed');
  assert.equal(brief('both-bad'), '-', 'an analysis failure is not a failed lookup: still never asked');
  suspect('year-bad');
  db.recordOriginalYearOutcome('year-bad', { kind: 'error', reason: 'timeout' });
  const head = db.requireDb()
    .prepare(`SELECT 1 FROM track_facet_status WHERE track_id = 'year-bad' AND facet <> 'year' AND status = 'failed'`).get();
  assert.equal(head, undefined, 'a lookup failure is not an analysis failure');
  db.clearAnalysis();
  db.clearAnalysisFailures('audio-bad');
  assert.equal(brief('year-bad'), 'failed:timeout×1', 'resetting the analysis keeps the year facet');
  consistent();
});

test('the walk re-derives the year row when it changes the era columns', () => {
  db.upsertTrackMeta('turns', { title: 'Turns', artist: 'A', album: 'Hits', year: 2012 });
  assert.equal(brief('turns'), 'ok:not-needed');
  suspect('turns');
  assert.equal(brief('turns'), '-', 'now era-suspect and never asked: due');
  assert.ok(db.yearLookupDueIds(Date.now()).includes('turns'));
  db.upsertTrackMeta('turns', { title: 'Turns', artist: 'A', album: 'Hits', year: 2012, eraUntrusted: false });
  assert.equal(brief('turns'), 'ok:not-needed');
  consistent();
});

test('an upgrade derives every year row, and old misses stay settled', async () => {
  suspect('legacy-miss');
  // A miss stamped by the old code: the checked stamp alone.
  db.requireDb().prepare(`UPDATE tracks SET original_year_checked_at = '2026-10-01T00:00:00Z' WHERE id = 'legacy-miss'`).run();
  // A pre-year table has no year rows (and no year failures, which this file's
  // earlier tests made: kept so the planner tests below can use them).
  db.requireDb().prepare(`DELETE FROM track_facet_status WHERE facet = 'year' AND status <> 'failed'`).run();
  db.requireDb().prepare(`UPDATE track_facet_meta SET stamp = 'pre-year'`).run();
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(brief('legacy-miss'), 'unmeasurable:not-found');
  assert.equal(brief('trusted'), 'ok:not-needed');
  assert.ok(!db.yearLookupDueIds(Date.now()).includes('legacy-miss'));
  consistent();
});

// ── planner ───────────────────────────────────────────────────────────────

const caps = { clap: true, demucs: true, tailVocal: true };
const yearPlan = (where: string, extra: Partial<Parameters<typeof plan.planAcoustics>[0]> = {}) => plan.planAcoustics({
  ids: db.allTrackIdsOrdered(),
  facets: ['year'],
  where: plan.parseWhere(where),
  state: db.loadFacetState(['year']),
  capabilities: caps,
  ...extra,
});

test('the planner: needs takes the never-asked and the retries that are due', () => {
  suspect('p-new');
  suspect('p-wait');
  db.recordOriginalYearOutcome('p-wait', { kind: 'error', reason: 'timeout' });
  suspect('p-ready');
  db.recordOriginalYearOutcome('p-ready', { kind: 'error', reason: 'timeout' });
  age('p-ready', 2 * HOUR);
  const ids = plan.yearPart(yearPlan('needs'));
  assert.ok(ids.includes('p-new') && ids.includes('p-ready'));
  assert.ok(!ids.includes('p-wait'), 'inside its retry delay');
  assert.ok(!ids.includes('missed'), 'a not-found is settled');
  assert.ok(!ids.includes('flaky'), 'three failures wait for --where failed');
  assert.deepEqual(new Set(ids), new Set(db.yearLookupDueIds(Date.now())), 'the planner and the automatic passes agree');
});

test('the planner: failed takes every failed lookup, exhausted or not; unmeasurable takes the misses', () => {
  const failed = plan.yearPart(yearPlan('failed'));
  assert.ok(failed.includes('flaky') && failed.includes('p-wait') && failed.includes('kept'));
  assert.ok(!failed.includes('p-new'));
  const misses = plan.yearPart(yearPlan('unmeasurable:not-found'));
  assert.ok(misses.includes('missed') && misses.includes('legacy-miss'));
  assert.ok(!misses.includes('trusted'));
});

test('the planner never plans a known year, and honours the setting', () => {
  const all = yearPlan('all');
  const ids = plan.yearPart(all);
  for (const id of ['trusted', 'resolved', 'manual', 'tagged']) assert.ok(!ids.includes(id), id);
  assert.ok(ids.includes('missed') && ids.includes('p-new'));
  assert.ok((all.byFacet[0].skipped['year-known'] ?? 0) > 0);
  const off = yearPlan('needs', { capabilities: { ...caps, yearLookups: false } });
  assert.equal(off.items.length, 0);
  assert.ok((off.byFacet[0].skipped['year-off'] ?? 0) > 0);
});

test('a year plan has no analyzer work; a mixed plan splits in two', () => {
  const y = yearPlan('needs');
  assert.equal(plan.analysisPart(y), null);
  assert.ok(plan.formatPlan(y).some(l => l.includes('MusicBrainz lookups (no analyzer involved)')));
  assert.ok(!plan.formatPlan(y).some(l => l.includes('older analyzer')));
  const mixed = plan.planAcoustics({
    ids: ['p-new'],
    facets: ['head', 'year'],
    where: { kind: 'needs' },
    state: db.loadFacetState(['head', 'year']),
    capabilities: caps,
  });
  assert.deepEqual(mixed.items[0].facets, ['head', 'year']);
  const audio = plan.analysisPart(mixed)!;
  assert.deepEqual(audio.items[0].facets, ['head']);
  assert.deepEqual(audio.facets, ['head']);
  assert.deepEqual(plan.yearPart(mixed), ['p-new']);
});

// ── the automatic passes ──────────────────────────────────────────────────

test('Reconcile and tag runs ask the due set; --re-enrich adds misses from the run only', () => {
  const due = db.yearLookupDueIds(Date.now());
  assert.deepEqual(pendingOriginalYearIds(false), due);
  assert.deepEqual(pendingOriginalYearIds(true), due, 're-enrich without a scope re-asks no miss');
  const scoped = pendingOriginalYearIds(true, ['missed', 'trusted']);
  assert.ok(scoped.includes('missed'));
  assert.ok(!scoped.includes('legacy-miss'), 'a miss outside the run is not re-asked');
  assert.ok(!scoped.includes('trusted'));
});

// ── the MusicBrainz client ────────────────────────────────────────────────

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
const answer = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
};
const track = { title: 'Plain Title', artist: 'Plain Artist', year: 2012 };

test('the client tells found, not found and error apart', async () => {
  answer(503, { error: 'rate limited' });
  assert.deepEqual(await lookupOriginalYear(track), { kind: 'error', reason: 'MusicBrainz HTTP 503' });
  globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND musicbrainz.org'); }) as typeof fetch;
  assert.deepEqual(await lookupOriginalYear(track), { kind: 'error', reason: 'getaddrinfo ENOTFOUND musicbrainz.org' });
  answer(200, { recordings: [] });
  assert.deepEqual(await lookupOriginalYear(track), { kind: 'not-found' });
  answer(200, { recordings: [{ score: 100, title: 'Plain Title', 'first-release-date': '1966-05-01', 'artist-credit': [{ name: 'Plain Artist' }] }] });
  assert.deepEqual(await lookupOriginalYear(track), { kind: 'found', year: 1966 });
});
