// Stem provenance (#2238, music/stem-provenance.ts + stem-cache.hasWindow).
//
// A stem dir is keyed by track id, which outlives a change of audio, and its
// windows are written at different times. Pinned here:
// - the rule: sizes decide when both are known, else durations within 2 s,
//   else unknown matches; it mirrors analyze_worker.py same_recording;
// - hasWindow is a miss for a window whose stamp disagrees with the other
//   window's, or with the row's file size (which it reads itself), and never
//   deletes anything;
// - a dir from before the stamps (no head-meta.json, a tail-meta.json with no
//   file_size) reads exactly as it did: an upgrade changes nothing;
// - the orphan purge still reads a dir holding head-meta.json as stems.
//
// Run: `npm test -- stem-provenance`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-stem-provenance-'));
process.env.STATE_DIR = stateRoot;
delete process.env.STEMS_DIR;

const provenance = await import('../src/music/stem-provenance.js');
const stemCache = await import('../src/music/stem-cache.js');
const { isStemDirListing } = await import('../src/music/orphan-purge-pure.js');

after(async () => {
  await removeTempDir(stateRoot);
});

const { sameRecording, windowUsable, parseStemStamp, UNKNOWN_STAMP } = provenance;
const stamp = (fileSize: number | null, durationSec: number | null) => ({ fileSize, durationSec });

test('sameRecording: sizes decide, then durations, then unknown matches', () => {
  assert.equal(sameRecording(stamp(10, 200), stamp(10, 200)), true);
  assert.equal(sameRecording(stamp(10, 200), stamp(11, 200)), false);
  // Both sizes known: the durations are not consulted.
  assert.equal(sameRecording(stamp(10, 100), stamp(10, 300)), true);
  assert.equal(sameRecording(stamp(null, 200), stamp(10, 201.5)), true);
  assert.equal(sameRecording(stamp(null, 200), stamp(10, 203)), false);
  assert.equal(sameRecording(UNKNOWN_STAMP, stamp(10, 200)), true);
});

test('parseStemStamp: the worker\'s fields, anything else unknown', () => {
  assert.deepEqual(parseStemStamp({ file_size: 1234, duration_sec: 200.5, tail_start_sec: 180 }), stamp(1234, 200.5));
  assert.deepEqual(parseStemStamp({ tail_start_sec: 180, duration_sec: 200 }), stamp(null, 200)); // pre-stamp tail-meta
  assert.deepEqual(parseStemStamp({ file_size: null, duration_sec: null }), UNKNOWN_STAMP); // a capped source
  assert.deepEqual(parseStemStamp({ file_size: -1, duration_sec: 'x' }), UNKNOWN_STAMP);
  assert.equal(parseStemStamp([]), null);
  assert.equal(parseStemStamp(null), null);
});

test('windowUsable: agrees with the other window and with the row', () => {
  assert.equal(windowUsable({ own: stamp(10, 200), other: stamp(10, 200), expectedFileSize: 10 }), true);
  assert.equal(windowUsable({ own: stamp(10, 200), other: stamp(11, 200) }), false);
  assert.equal(windowUsable({ own: stamp(10, 200), other: null, expectedFileSize: 11 }), false);
  // Unknown on either side is no evidence against.
  assert.equal(windowUsable({ own: UNKNOWN_STAMP, other: null, expectedFileSize: 11 }), true);
  assert.equal(windowUsable({ own: stamp(10, 200), other: null, expectedFileSize: null }), true);
});

const STEMS = ['drums', 'bass', 'other', 'vocals'];
let n = 0;
function trackDir(opts: { head?: object | 'none' | 'bad'; tail?: object | 'none' | 'bad' }): string {
  const id = `track-${++n}`;
  const dir = stemCache.dirFor(id);
  mkdirSync(dir, { recursive: true });
  for (const w of ['head', 'tail']) {
    for (const s of STEMS) writeFileSync(path.join(dir, `${w}-${s}.flac`), 'stem');
  }
  const meta = (file: string, v: object | 'none' | 'bad' | undefined) => {
    if (v === undefined || v === 'none') return;
    writeFileSync(path.join(dir, file), v === 'bad' ? '{not json' : JSON.stringify(v));
  };
  meta(provenance.HEAD_META, opts.head);
  meta(provenance.TAIL_META, opts.tail);
  return id;
}

const TAIL_OLD = { tail_start_sec: 180, duration_sec: 200 }; // written before #2238
const tailMeta = (fileSize: number | null, durationSec = 200) =>
  ({ tail_start_sec: durationSec - 20, duration_sec: durationSec, file_size: fileSize });
const headMeta = (fileSize: number | null, durationSec: number | null = 200) =>
  ({ file_size: fileSize, duration_sec: durationSec });

test('hasWindow: a dir from before the stamps reads as it always did', async () => {
  const id = trackDir({ tail: TAIL_OLD });
  assert.equal(await stemCache.hasWindow(id, 'head'), true);
  assert.equal(await stemCache.hasWindow(id, 'tail'), true);
  // The row's size cannot judge a window that never recorded one.
  assert.equal(await stemCache.hasWindow(id, 'head', { fileSize: 999 }), true);
  assert.equal(await stemCache.hasWindow(id, 'tail', { fileSize: 999 }), true);
  // A tail still needs its alignment sidecar.
  const noMeta = trackDir({});
  assert.equal(await stemCache.hasWindow(noMeta, 'tail'), false);
  assert.equal(await stemCache.hasWindow(noMeta, 'head'), true);
});

test('hasWindow: one recording\'s head beside another\'s tail is a miss both ways (#2238)', async () => {
  const id = trackDir({ head: headMeta(6_000_000, 260), tail: tailMeta(5_000_000, 200) });
  assert.equal(await stemCache.hasWindow(id, 'head'), false);
  assert.equal(await stemCache.hasWindow(id, 'tail'), false);
  // A plain miss: nothing is evicted.
  assert.equal(existsSync(stemCache.stemPath(id, 'tail', 'drums')), true);
  assert.equal(existsSync(path.join(stemCache.dirFor(id), provenance.TAIL_META)), true);

  // A new head over a pre-stamp tail-meta.json: judged by duration.
  const legacy = trackDir({ head: headMeta(6_000_000, 260), tail: TAIL_OLD });
  assert.equal(await stemCache.hasWindow(legacy, 'tail'), false);
  const legacySame = trackDir({ head: headMeta(6_000_000, 200.4), tail: TAIL_OLD });
  assert.equal(await stemCache.hasWindow(legacySame, 'tail'), true);
});

test('hasWindow: a window stamped with another file than the row\'s is a miss', async () => {
  const id = trackDir({ head: headMeta(5_000_000), tail: tailMeta(5_000_000) });
  assert.equal(await stemCache.hasWindow(id, 'head', { fileSize: 5_000_000 }), true);
  assert.equal(await stemCache.hasWindow(id, 'tail', { fileSize: 5_000_000 }), true);
  // The file was replaced: the row records the new size.
  assert.equal(await stemCache.hasWindow(id, 'head', { fileSize: 6_000_000 }), false);
  assert.equal(await stemCache.hasWindow(id, 'tail', { fileSize: 6_000_000 }), false);
  // A capped source stamped nothing: no evidence against.
  const capped = trackDir({ head: headMeta(null, null), tail: tailMeta(5_000_000) });
  assert.equal(await stemCache.hasWindow(capped, 'head', { fileSize: 6_000_000 }), true);
});

test('hasWindow: an unreadable meta', async () => {
  // The tail's own sidecar unreadable: a miss, as it was at render time.
  const badTail = trackDir({ head: headMeta(5_000_000), tail: 'bad' });
  assert.equal(await stemCache.hasWindow(badTail, 'tail'), false);
  // The head's own stamp unreadable is no proof either.
  const badHead = trackDir({ head: 'bad', tail: tailMeta(5_000_000) });
  assert.equal(await stemCache.hasWindow(badHead, 'head'), false);
  assert.equal(await stemCache.hasWindow(badHead, 'tail'), true);
});

test('hasWindow reads the row\'s file size itself: a caller cannot leave the check out', async () => {
  const db = await import('../src/music/library-db.js');
  await db.open({ embeddingDim: 768, adoptStoredDim: true });
  try {
    const id = trackDir({ head: headMeta(5_000_000), tail: tailMeta(5_000_000) });
    db.upsertTrackMeta(id, { title: 'T', artist: 'A', album: 'B', duration: 200, fileSize: 5_000_000 });
    assert.equal(await stemCache.hasWindow(id, 'head'), true);
    assert.equal(await stemCache.hasWindow(id, 'tail'), true);
    // The row now records another file (an accepted replacement, #2328 review).
    db.acceptReplacedFiles(new Map([[id, 6_000_000]]));
    assert.equal(await stemCache.hasWindow(id, 'head'), false);
    assert.equal(await stemCache.hasWindow(id, 'tail'), false);
    // A row with no known size judges nothing.
    const unsized = trackDir({ head: headMeta(5_000_000), tail: tailMeta(5_000_000) });
    db.upsertTrackMeta(unsized, { title: 'U', artist: 'A', album: 'B', duration: 200 });
    assert.equal(await stemCache.hasWindow(unsized, 'head'), true);
  } finally {
    db.close();
  }
});

test('the orphan purge reads a dir with head-meta.json as stems', () => {
  const entries = (names: string[]) => names.map(name => ({ name, isDirectory: false }));
  assert.equal(isStemDirListing(entries(['head-drums.flac', 'head-meta.json', 'tail-meta.json'])), true);
  assert.equal(isStemDirListing(entries(['head-meta.json'])), true);
  assert.equal(isStemDirListing(entries(['head-meta.json', 'notes.txt'])), false);
});
