// The strict-show pool built from the paged library read (pick.showLibraryPool,
// #2377) is the same pool as strictShowLibraryPool over the whole read. The
// strict locks never-starve per dimension, so filtering page by page let any
// page with no genre match skip the genre lock and bring every row on it in:
// Night Signal's 49 tracks became 549 in a 1,049-track library, and the hard
// no-repeat window was sized from the library again.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-show-pool-paged-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://show-pool-paged.invalid';
const { strictShowLibraryPool, strictShowLibraryPoolSliced } = await import('../src/music/show-recency.js');
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
await library.load();
after(async () => {
  library.shutdown();
  await removeTempDir(stateRoot);
});

// Night Signal's shape over more than two pages: the 49 Electronic tracks all
// sit on the first page, so every later page holds no match.
const TOTAL = db.CANDIDATE_FILTER_PAGE_ROWS * 2 + 49;
const insert = db.requireDb().prepare('INSERT INTO tracks (id, title, artist, genres, duration_sec) VALUES (?, ?, ?, ?, ?)');
db.requireDb().transaction(() => {
  for (let i = 0; i < TOTAL; i++) {
    insert.run(`t-${i}`, `Track ${i}`, `Artist ${i % 17}`, JSON.stringify([i < 49 ? 'Electronic' : 'Punjabi']), 200);
  }
})();

const strictShow = { filtersStrict: true, genres: ['Electronic'] };
const ids = (rows: Array<{ id: string }> | null) => rows?.map(r => r.id).sort() ?? null;

test('the paged pool is the whole-read pool on a library larger than one page', async () => {
  const whole = strictShowLibraryPool(library.candidateFilterTracks(), { show: strictShow, excludedIds: null });
  assert.equal(whole?.length, 49);
  const paged = await strictShowLibraryPoolSliced(
    library.candidateFilterTrackBatches(), { show: strictShow, excludedIds: null }, library.candidateFilterTracks,
  );
  assert.deepEqual(ids(paged), ids(whole));

  const opts = { show: strictShow, excludedIds: new Set(['t-0', 't-1']), minTrackSec: 120 };
  assert.deepEqual(
    ids(await strictShowLibraryPoolSliced(library.candidateFilterTrackBatches(), opts, library.candidateFilterTracks)),
    ids(strictShowLibraryPool(library.candidateFilterTracks(), opts)),
    'exclusions and the length floor match too',
  );
});

test('a non-strict show reads no pages', async () => {
  let pulled = 0;
  async function* counted() {
    for await (const page of library.candidateFilterTrackBatches()) { pulled++; yield page; }
  }
  assert.equal(await strictShowLibraryPoolSliced(counted(), { show: { filtersStrict: false, genres: ['Electronic'] }, excludedIds: null }), null);
  assert.equal(pulled, 0);
});

test('a library reopened between pages falls back to the whole read', async () => {
  // A backup restore (library.reload()) after the first page: the paged read
  // stops instead of reading a closed statement, and the pool is the whole read.
  async function* reloadedMidScan() {
    let first = true;
    for await (const page of library.candidateFilterTrackBatches()) {
      yield page;
      if (first) { first = false; await library.reload(); }
    }
  }
  const scan = reloadedMidScan();
  await assert.rejects(async () => { for await (const _page of scan) { /* drain */ } }, /reopened during a paged candidate scan/);

  const paged = await strictShowLibraryPoolSliced(reloadedMidScan(), { show: strictShow, excludedIds: null }, library.candidateFilterTracks);
  assert.deepEqual(ids(paged), ids(strictShowLibraryPool(library.candidateFilterTracks(), { show: strictShow, excludedIds: null })));
  assert.equal(paged?.length, 49);
});
