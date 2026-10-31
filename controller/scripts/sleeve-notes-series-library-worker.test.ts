import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import { rmSync } from 'node:fs';
import { open, close, DB_PATH } from '../src/sleeve-notes/db.js';
import * as settings from '../src/settings.js';
import * as repository from '../src/sleeve-notes/research-repository.js';
import { DEFAULT_MUSICBRAINZ_SERIES } from '../src/sleeve-notes/musicbrainz-series-catalog.js';
import { MusicBrainzSeriesLibraryWorker } from '../src/sleeve-notes/musicbrainz-series-library-worker.js';
import { ConnectionLibraryWorker } from '../src/sleeve-notes/connection-library-worker.js';
import { stopConnectionCompute } from '../src/sleeve-notes/connection-compute.js';
const series = DEFAULT_MUSICBRAINZ_SERIES.find(item => item.entityType === 'recording')!;
const member = '33333333-3333-4333-8333-333333333333';
const snapshot = { id: series.id, name: series.label, type: 'Recording series', members: [{ id: member, title: 'Song', rank: '1' }] };
let quiet = true;
let albums = ['a', 'b'];
let calls: string[] = [];
let fail: string | null = null;
const catalogue = {
  async getAlbumList(offset = 0, limit = 25) { calls.push(`list:${offset}`); return albums.slice(offset, offset + limit).map(id => ({ id })); },
  async getAlbumWithSongs(id: string) {
    calls.push(id);
    if (fail === id) throw new Error('Temporary catalogue failure');
    return { album: { id, name: id }, songs: [{ id: `${id}-track`, title: 'Song', artist: 'Artist', musicBrainzId: member }] };
  },
  async getScanStatus() { return false; },
};
beforeEach(async () => {
  close(); for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  await settings.update({ djBehaviour: { extendedSleeveNotes: true, sleeveNotesCollectionPaused: false } });
  quiet = true; albums = ['a', 'b']; calls = []; fail = null;
  repository.retainMusicBrainzSeriesSnapshot(series, snapshot);
});
afterEach(() => stopConnectionCompute());
after(() => close());
const worker = () => new MusicBrainzSeriesLibraryWorker({ isQuiet: () => quiet }, catalogue);
const count = (table: string) => (open().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('one sweep settles, stays idle after restart, and an unchanged 30-day refresh preserves facts and cursor', async () => {
  const run = worker();
  assert.equal(await run.runOnce(), true);
  assert.equal(await run.runOnce(), true);
  const claims = open().prepare('SELECT * FROM sleeve_claims ORDER BY id').all();
  const sources = count('sleeve_source_documents');
  calls = [];
  assert.equal(await worker().runOnce(), false);
  assert.equal(repository.dueSeriesLibraryScanOffset(new Date('2030-01-01')), null);
  repository.retainMusicBrainzSeriesSnapshot(series, snapshot, new Date('2030-01-01'));
  assert.equal(repository.dueSeriesLibraryScanOffset(new Date('2030-01-02')), null);
  assert.equal(await worker().runOnce(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(open().prepare('SELECT * FROM sleeve_claims ORDER BY id').all(), claims);
  assert.equal(count('sleeve_source_documents'), sources);
  assert.equal(count('sleeve_series_library_claims'), 2);
});

test('real catalogue worker queues only new/changed albums; removal retires pending work', async () => {
  const run = worker(); await run.runOnce(); await run.runOnce();
  const scan = new ConnectionLibraryWorker({ isQuiet: () => quiet }, catalogue);
  await scan.runOnce(); await scan.runOnce();
  assert.deepEqual(repository.pendingSeriesLibraryAlbums(), []);
  albums.push('c');
  await scan.runOnce(Date.now() + 20 * 60_000);
  calls = [];
  assert.equal(await worker().runOnce(), true);
  assert.deepEqual(calls, ['c']);
  assert.equal(count('sleeve_series_library_claims'), 3);
  assert.equal(repository.dueSeriesLibraryScanOffset(), null);
  repository.observeSeriesLibraryAlbum(open(), { id: 'b', name: 'Renamed' }, [{ id: 'b-track', musicBrainzId: member }]);
  assert.deepEqual(repository.pendingSeriesLibraryAlbums(), ['b']);
  calls = []; await worker().runOnce(); assert.deepEqual(calls, ['b']);
  repository.observeSeriesLibraryAlbum(open(), { id: 'deleted' }, []);
  await scan.runOnce(Date.now() + 20 * 60_000);
  assert.deepEqual(repository.pendingSeriesLibraryAlbums(), []);
});

test('changed list restarts matching, but successful albums survive a later page failure and restart', async () => {
  fail = 'b'; await worker().runOnce();
  assert.equal(count('sleeve_series_library_claims'), 1);
  assert.equal(repository.dueSeriesLibraryScanOffset(new Date(Date.now() + 11 * 60_000)), 1);
  repository.deferSeriesLibraryScan(0); fail = null; calls = [];
  await worker().runOnce(); assert.deepEqual(calls, ['list:1', 'b']);
  await worker().runOnce();
  repository.retainMusicBrainzSeriesSnapshot(series, { ...snapshot, members: [{ ...snapshot.members[0], rank: '2' }] });
  assert.equal(repository.dueSeriesLibraryScanOffset(), 0);
  await worker().runOnce();
  assert.match((open().prepare('SELECT wording FROM sleeve_claims WHERE enabled = 1').get() as { wording: string }).wording, /2/);
});

test('changed-album failures keep full sweep idle, and quiet/master/pause gates prevent calls', async () => {
  await worker().runOnce(); await worker().runOnce();
  repository.observeSeriesLibraryAlbum(open(), { id: 'c' }, []);
  fail = 'c'; await worker().runOnce();
  assert.equal(repository.dueSeriesLibraryScanOffset(new Date(Date.now() + 11 * 60_000)), null);
  assert.deepEqual(repository.pendingSeriesLibraryAlbums(), ['c']);
  calls = []; quiet = false; assert.equal(await worker().runOnce(), false);
  quiet = true;
  await settings.update({ djBehaviour: { sleeveNotesCollectionPaused: true } });
  assert.equal(await worker().runOnce(), false);
  await settings.update({ djBehaviour: { sleeveNotesCollectionPaused: false, extendedSleeveNotes: false } });
  assert.equal(await worker().runOnce(), false);
  assert.deepEqual(calls, []);
});
