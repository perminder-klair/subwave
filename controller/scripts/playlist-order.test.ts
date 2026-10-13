// Play in order (show.playlistInOrder) — a show's anchor playlist airs top to
// bottom, resumes where the last airing left off, and loops at the end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anchorSignature,
  cursorFor,
  isInOrderShow,
  nextInOrder,
  resumeIndex,
  type PlaylistCursor,
} from '../src/music/playlist-order.js';
import { createPlaylistCursorStore } from '../src/music/playlist-cursors.js';
import { airableAnchorTracks } from '../src/music/show-recency.js';

type Track = { id: string; title: string; artist: string; genres: string[]; durationSec?: number };

const makeTracks = (n: number): Track[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Track ${i + 1}`,
    artist: `Artist ${i + 1}`,
    genres: ['Jazz'],
  }));

const SIG = anchorSignature(['pl_a', 'pl_b']);
const any = () => true;
const cursorAt = (tracks: Track[], index: number, sig = SIG): PlaylistCursor => cursorFor(tracks[index], index, sig);
const nextIndex = (tracks: Track[], cursor: PlaylistCursor | null, eligible: (t: Track) => boolean = any) =>
  nextInOrder(tracks, cursor, SIG, eligible)?.index ?? null;

// ---------------------------------------------------------------------------
// The switch

test('only an explicit true on BOTH strict and in-order turns the walk on', () => {
  assert.equal(isInOrderShow(null), false);
  assert.equal(isInOrderShow({}), false);
  assert.equal(isInOrderShow({ playlistInOrder: true }), false, 'inert without playlistStrict');
  assert.equal(isInOrderShow({ playlistStrict: true }), false, 'absent = shuffled, as shipped');
  assert.equal(isInOrderShow({ playlistStrict: true, playlistInOrder: false }), false);
  assert.equal(isInOrderShow({ playlistStrict: true, playlistInOrder: 'yes' }), false, 'showBool reads only literal true');
  assert.equal(isInOrderShow({ playlistStrict: true, playlistInOrder: true }), true);
});

test('the anchor signature follows WHICH playlists, in their order', () => {
  assert.equal(anchorSignature(['a', 'b']), 'a,b');
  assert.notEqual(anchorSignature(['a', 'b']), anchorSignature(['b', 'a']),
    'reordering the pinned playlists changes the running order, so it must restart the walk');
  assert.equal(anchorSignature(['a', '', null, 3, 'b']), 'a,b');
  assert.equal(anchorSignature(null), '');
});

// ---------------------------------------------------------------------------
// The walk

test('a show with no saved position starts at the top', () => {
  assert.equal(nextIndex(makeTracks(10), null), 0);
});

test('the walk continues one past the last pick', () => {
  const tracks = makeTracks(10);
  assert.equal(nextIndex(tracks, cursorAt(tracks, 4)), 5);
});

test('the walk loops to the top after the last track', () => {
  const tracks = makeTracks(10);
  assert.equal(nextIndex(tracks, cursorAt(tracks, 9)), 0);
});

test('a different anchor restarts the walk at the top', () => {
  const tracks = makeTracks(10);
  const cursor = cursorAt(tracks, 4, anchorSignature(['pl_old']));
  assert.equal(nextIndex(tracks, cursor), 0);
});

test('a last pick removed from the playlist resumes at its old slot (its successor slid in)', () => {
  const tracks = makeTracks(10);
  const cursor = cursorAt(tracks, 4); // t5
  const edited = tracks.filter(t => t.id !== 't5');
  const next = nextInOrder(edited, cursor, SIG, any);
  assert.equal(next?.track.id, 't6');
});

test('a last pick that was the final track and was removed wraps to the top', () => {
  const tracks = makeTracks(10);
  const cursor = cursorAt(tracks, 9); // t10
  const edited = tracks.slice(0, 9);
  assert.equal(nextInOrder(edited, cursor, SIG, any)?.track.id, 't1');
});

test('a last pick moved within the playlist is followed to its new place', () => {
  const tracks = makeTracks(10);
  const cursor = cursorAt(tracks, 2); // t3
  const moved = [...tracks.filter(t => t.id !== 't3')];
  moved.splice(7, 0, tracks[2]); // t3 now at slot 7
  assert.equal(nextInOrder(moved, cursor, SIG, any)?.track.id, moved[8].id);
});

test('a Navidrome id rotation is found again by title and artist', () => {
  const tracks = makeTracks(10);
  const cursor = cursorAt(tracks, 4); // t5
  const rotated = tracks.map(t => ({ ...t, id: `new-${t.id}` }));
  // Slot 4 no longer matches by id, and nothing does — only the key finds it.
  assert.equal(resumeIndex(rotated, cursor, SIG), 5);
  // Shift everything by one so the slot itself is wrong too.
  const shifted = [{ id: 'intro', title: 'Intro', artist: 'Host', genres: [] }, ...rotated];
  assert.equal(nextInOrder(shifted, cursor, SIG, any)?.track.id, 'new-t6');
});

test('the slot wins over an earlier copy of the same song', () => {
  const tracks = makeTracks(10);
  const withRepeat = [...tracks];
  withRepeat[7] = { ...tracks[2] }; // t3 pinned twice, at slots 2 and 7
  const cursor = cursorFor(withRepeat[7], 7, SIG);
  assert.equal(nextIndex(withRepeat, cursor), 8, 'must not jump back to the first copy');
});

test('ineligible tracks are stepped over, in order', () => {
  const tracks = makeTracks(10);
  const blocked = new Set(['t6', 't7']);
  const next = nextInOrder(tracks, cursorAt(tracks, 4), SIG, t => !blocked.has(t.id));
  assert.equal(next?.track.id, 't8');
  assert.equal(next?.index, 7, 'the index is the slot in the FULL list, not the filtered one');
});

test('a step over the end of the list wraps to the first eligible track', () => {
  const tracks = makeTracks(5);
  const next = nextInOrder(tracks, cursorAt(tracks, 3), SIG, t => t.id !== 't5');
  assert.equal(next?.track.id, 't1');
});

test('nothing eligible answers null after one lap instead of spinning', () => {
  const tracks = makeTracks(10);
  assert.equal(nextInOrder(tracks, cursorAt(tracks, 4), SIG, () => false), null);
  assert.equal(nextInOrder([], null, SIG, any), null);
});

test('a single-track playlist whose only track is on air has nothing to pick', () => {
  const tracks = makeTracks(1);
  const busy = new Set(['t1']);
  assert.equal(nextInOrder(tracks, cursorAt(tracks, 0), SIG, t => !busy.has(t.id)), null,
    'push() would refuse it as a duplicate, so the walk stands aside');
});

// ---------------------------------------------------------------------------
// Eligibility is the SAME set the no-repeat guard counts

test('airableAnchorTracks keeps the anchor order and drops what cannot air', () => {
  const tracks: Track[] = makeTracks(8).map((t, i) => ({ ...t, durationSec: i === 2 ? 30 : 240 }));
  const out = airableAnchorTracks(tracks, {
    show: { playlistStrict: true },
    excludedIds: new Set(['t5']),
    minTrackSec: 60,
    maxTrackSec: null,
  });
  assert.deepEqual(out.map(t => t.id), ['t1', 't2', 't4', 't6', 't7', 't8']);
});



// ---------------------------------------------------------------------------
// The durable position

function tempStore(knownShowIds: () => Iterable<string> = () => ['s_one', 's_two']) {
  const dir = mkdtempSync(join(tmpdir(), 'playlist-cursors-'));
  const file = join(dir, 'playlist-cursors.json');
  return { dir, file, store: () => createPlaylistCursorStore({ file, knownShowIds }) };
}

test('a committed position survives a cold load', async () => {
  const { dir, file, store } = tempStore();
  try {
    const tracks = makeTracks(10);
    await store().commit('s_one', cursorAt(tracks, 6));
    const reloaded = await store().get('s_one');
    assert.equal(reloaded?.index, 6);
    assert.equal(reloaded?.lastId, 't7');
    assert.equal(reloaded?.lastKey, 'track 7|artist 7');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or corrupt file starts every show from the top', async () => {
  const { dir, file, store } = tempStore();
  try {
    assert.equal(await store().get('s_one'), null);
    writeFileSync(file, '{ not json');
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await store().get('s_one'), null);
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deleted show loses its position on the next write; reset returns to the top', async () => {
  let known = ['s_one', 's_two'];
  const { dir, store } = tempStore(() => known);
  try {
    const tracks = makeTracks(10);
    const s = store();
    await s.commit('s_one', cursorAt(tracks, 1));
    await s.commit('s_two', cursorAt(tracks, 2));
    known = ['s_two'];
    await s.commit('s_two', cursorAt(tracks, 3));
    const cold = store();
    assert.equal(await cold.get('s_one'), null, 'the deleted show was pruned');
    assert.equal((await cold.get('s_two'))?.index, 3);
    assert.equal(await cold.reset('s_two'), true);
    assert.equal(await cold.reset('s_two'), false, 'nothing left to reset');
    assert.equal(await store().get('s_two'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The running order across airings, through the real store

test('two airings play 1…40 then loop, continuing where the first left off', async () => {
  const { dir, store } = tempStore();
  try {
    const tracks = makeTracks(40);
    const aired: number[] = [];
    // Each airing is a fresh store, as after a controller restart; the queue
    // holds the previous pick while the next is chosen (one-ahead picking).
    for (const picks of [25, 25]) {
      const s = store();
      let queued: string | null = null;
      for (let i = 0; i < picks; i++) {
        const busy = new Set(queued ? [queued] : []);
        const next = nextInOrder(tracks, await s.get('s_one'), SIG, t => !busy.has(t.id));
        assert.ok(next, 'a 40-track list always has a next track');
        await s.commit('s_one', cursorFor(next.track, next.index, SIG));
        aired.push(next.index + 1);
        queued = next.track.id;
      }
    }
    const expected = [...Array.from({ length: 40 }, (_, i) => i + 1), ...Array.from({ length: 10 }, (_, i) => i + 1)];
    assert.deepEqual(aired, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Wiring. A switch reaches the air only if every link in the chain carries it.

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');





test('runTrackEvent walks in order after the budget gate and before mini-run steering', () => {
  const source = read('../src/broadcast/dj-agent.ts');
  const body = source.slice(source.indexOf('export async function runTrackEvent('));
  const budgetAt = body.indexOf('budget.picksAllowed()');
  const inOrderAt = body.indexOf('await pickInOrder(');
  const runAt = body.indexOf('advanceRun(djMode');
  const pickerAt = body.search(/(?:pickViaSelectionRoute|pickViaAgent)\(/);
  assert.ok(budgetAt > 0 && inOrderAt > budgetAt, 'the hard token cap still stops every pick');
  assert.ok(runAt > inOrderAt, 'in-order picks must not advance a DJ-mode run');
  assert.ok(pickerAt > inOrderAt, 'the walk runs before the configured model picker');
});

test('the in-order pick shares the pool path\'s link + enqueue and commits after it', () => {
  const source = read('../src/broadcast/dj-agent.ts');
  const fn = source.slice(source.indexOf('async function pickInOrder('));
  const enqueueAt = fn.indexOf('enqueueSelected(');
  const commitAt = fn.indexOf('commitInOrderPick(');
  assert.ok(enqueueAt > 0 && commitAt > enqueueAt, 'the position advances only once the pick reached the queue');
  assert.match(source, /async function pickViaPool\([\s\S]{0,1200}return enqueueSelected\(queue, ctx, result,/,
    'the pool fallback must still go through the same enqueue half');
});

test('eligibility comes from the one airable set both the walk and the guard read', () => {
  assert.match(read('../src/music/playlist-order-next.ts'), /airableAnchorTracks\(pool\.tracks/);
  assert.match(read('../src/music/show-recency.ts'), /const airable = airableAnchorTracks\(playlistTracks/);
});
