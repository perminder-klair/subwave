// L3: when spacing has to relax, the artist heard LONGEST ago plays.
//
// Seen on air 10 Oct, show "Sunrise On The Beach" (strict filters): Katerine
// "Jesus Christ mon amour" on air, then Norah Jones queued (pair drain, so the
// pick anchor was the queue head), then Katerine again at 06:08. The run's
// candidates were all inside the 12-slot window, so the guard yielded and kept
// the model's pick: the artist from two slots back, while candidates heard far
// longer ago sat in the same run. Now the guard takes the candidate whose
// artist is furthest back, with no model call; with none further back than the
// pick, the pick stands as before.
// Run: npm test -- artist-guard-least-recent

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artistRootKey,
  creditDistance,
  leastRecentAlternative,
  runArtistGuard,
} from '../src/broadcast/dj-agent/artist-guard.js';
import { queue } from '../src/broadcast/queue.js';
import { setKnownActsProvider } from '../src/music/recency.js';

type Cand = { id: string; title: string; artist: string };

const katerine: Cand = { id: 'k2', title: 'Copenhague', artist: 'Katerine' };
const norah: Cand = { id: 'n1', title: 'To Live', artist: 'Norah Jones' };
const air: Cand = { id: 'a1', title: 'La femme d\'argent', artist: 'Air' };
const zero7: Cand = { id: 'z1', title: 'Destiny', artist: 'Zero 7' };
const bebel: Cand = { id: 'b1', title: 'Samba', artist: 'Bebel Gilberto' };

const seenOf = (...songs: Cand[]) => new Map(songs.map((s) => [s.id, s]));
// Distances as queue.neighbourArtistDistances returns them: 1 = queue tail.
const dist = (...pairs: [string, number][]) => new Map(pairs.map(([a, d]) => [artistRootKey(a), d]));
// The 10 Oct window: Norah Jones queued (1), Katerine on air (2), then plays.
const window10Oct = dist(['Norah Jones', 1], ['Katerine', 2], ['Bebel Gilberto', 4], ['Zero 7', 7], ['Air', 11]);
const rootsOf = (d: Map<string, number>) => new Set(d.keys());

function harness() {
  const calls = { repick: 0, poolRescue: 0 };
  const lines: string[] = [];
  const events: Record<string, unknown>[] = [];
  return {
    calls, lines, events,
    deps: {
      repick: async () => { calls.repick++; return null; },
      poolRescue: async () => { calls.poolRescue++; return 'empty' as const; },
      log: (line: string) => { lines.push(line); },
      logEvent: (_name: string, payload: Record<string, unknown>) => { events.push(payload); },
    },
  };
}

const run = (h: ReturnType<typeof harness>, o: {
  song: Cand; pickAnchor: Cand | null; seen: Map<string, Cand>;
  distances?: Map<string, number>; roots?: Set<string>;
}) => runArtistGuard<Cand>({
  song: o.song,
  object: { id: o.song.id, reason: 'written for the original pick', transition: 'sweep' },
  pickAnchor: o.pickAnchor,
  seen: o.seen,
  recentRoots: o.roots ?? rootsOf(o.distances ?? window10Oct),
  recentDistances: o.distances,
  window: 12,
  ...h.deps,
});

test('the 10 Oct case: Katerine two slots back gives way to the artist heard longest ago', async () => {
  const h = harness();
  const out = await run(h, { song: katerine, pickAnchor: norah, seen: seenOf(katerine, bebel, air, zero7), distances: window10Oct });
  assert.equal(out.kind, 'repicked');
  assert.equal(out.kind === 'repicked' && out.song.artist, 'Air', '11 slots back beats 7 and 4');
  assert.deepEqual(h.calls, { repick: 0, poolRescue: 0 }, 'no model call, no pool call');
  assert.equal(h.events.at(-1)?.reason, 'all-recent');
  assert.equal(h.events.at(-1)?.swapped, 'least-recent');
  assert.equal(h.events.at(-1)?.fromSlots, 2);
  assert.equal(h.events.at(-1)?.toSlots, 11);
  assert.match(h.lines.at(-1)!, /swapped for "La femme d'argent" by Air \(11 slots ago\)/);
});

test('a swapped pick carries none of the model\'s note or transition', async () => {
  const out = await run(harness(), { song: katerine, pickAnchor: norah, seen: seenOf(katerine, air), distances: window10Oct });
  assert.equal(out.kind, 'repicked');
  if (out.kind !== 'repicked') return;
  assert.deepEqual(out.object, { id: 'a1', reason: '', musicalReason: '', transition: null });
});

test('the pick stands when no candidate was heard longer ago than it', async () => {
  const h = harness();
  const d = dist(['Norah Jones', 1], ['Bebel Gilberto', 2], ['Katerine', 9]);
  const out = await run(h, { song: katerine, pickAnchor: norah, seen: seenOf(katerine, bebel), distances: d });
  assert.equal(out.kind, 'kept');
  assert.match(h.lines.at(-1)!, /no fresher artist/);
  assert.equal(h.events.at(-1)?.swapped, undefined);
});

test('the anchor artist is never the swap, even when it is furthest back in the window', async () => {
  // A held pair-drain anchor can sit far back in the window's history too.
  const d = dist(['Bebel Gilberto', 1], ['Katerine', 2], ['Norah Jones', 12]);
  const out = await run(harness(), { song: katerine, pickAnchor: norah, seen: seenOf(katerine, norah, bebel), distances: d });
  assert.equal(out.kind, 'kept', 'Norah Jones is the anchor; Bebel is nearer than the pick');
});

test('ties keep the run\'s own order', () => {
  const d = dist(['Katerine', 2], ['Air', 8], ['Zero 7', 8]);
  const best = leastRecentAlternative(seenOf(zero7, air), katerine, d, '');
  assert.equal(best?.song.artist, 'Zero 7', 'first listed wins a tie');
});

test('without distances the guard behaves exactly as before', async () => {
  const h = harness();
  const out = await run(h, { song: katerine, pickAnchor: norah, seen: seenOf(katerine, air), roots: rootsOf(window10Oct) });
  assert.equal(out.kind, 'kept');
  assert.match(h.lines.at(-1)!, /no fresher artist/);
});

test('a re-pick with fresh artists available is untouched: the swap is only for the relaxed case', async () => {
  const h = harness();
  const fresh: Cand = { id: 'f1', title: 'Fresh', artist: 'Nouvelle Vague' };
  const out = await run(h, { song: katerine, pickAnchor: norah, seen: seenOf(katerine, air, fresh), distances: window10Oct });
  assert.equal(h.calls.repick, 1, 'the model re-pick still runs');
  assert.equal(out.kind, 'kept', 'this harness re-pick fails, so the pick is kept as before');
});

test('creditDistance: a credit is as recent as its nearest act', () => {
  const d = dist(['Marvin Gaye', 3], ['Tammi Terrell', 9]);
  assert.equal(creditDistance({ artist: 'Marvin Gaye' }, d), 3);
  assert.equal(creditDistance({ artist: 'Prince' }, d), Infinity);
  assert.equal(creditDistance({ artist: 'The Marvin Gaye' }, d), 3, 'matched like the window matches');
});

// artistRootKey keeps a " • " credit whole, so the window can hold the solo
// act and the combined credit as two keys. The nearer one is the distance,
// whichever of the two is the exact key.
test('creditDistance: a nearer combined credit beats an exact solo entry further back, both ways', () => {
  const d = dist(['Pixies • Black Francis', 1], ['Norah Jones', 2], ['Pixies', 9]);
  assert.equal(creditDistance({ artist: 'Pixies' }, d), 1, 'the combined credit one slot back');
  const reverse = dist(['Pixies', 1], ['Norah Jones', 2], ['Pixies • Black Francis', 9]);
  assert.equal(creditDistance({ artist: 'Pixies • Black Francis' }, reverse), 1, 'the solo act one slot back');
});

// Reaches the queue's private fields to stage a window without a live station.
type Staged = '_recentPlays' | 'current' | 'upcoming';
const q = queue as unknown as Omit<typeof queue, Staged> & Record<Staged, unknown>;
function staged(window: { upcoming: unknown[]; current: unknown; plays: unknown[] }, fn: () => void | Promise<void>) {
  const saved = { plays: q._recentPlays, current: q.current, upcoming: q.upcoming };
  q.upcoming = window.upcoming; q.current = window.current; q._recentPlays = window.plays;
  return (async () => fn())().finally(() => {
    q._recentPlays = saved.plays; q.current = saved.current; q.upcoming = saved.upcoming;
  });
}
const play = (id: string, artist: string) => ({ id, title: `Track ${id}`, artist });

test('the swap never lands on an act heard one slot ago under another credit', () => staged({
  // Queue tail "Pixies • Black Francis" (1), Norah Jones on air (2), then
  // plays back to a solo Pixies (9). Read as nine slots ago, Pixies was the
  // furthest-back candidate and aired straight after its own combined credit.
  upcoming: [{ track: { id: 'u1', artist: 'Pixies • Black Francis' } }],
  current: { track: { id: 'c1', artist: 'Norah Jones' } },
  plays: [
    play('p1', 'Katerine'), play('p2', 'Air'), play('p3', 'Zero 7'), play('p4', 'Bebel Gilberto'),
    play('p5', 'Moby'), play('p6', 'Portishead'), play('p7', 'Pixies'),
  ],
}, async () => {
  const pixies: Cand = { id: 'px1', title: 'Where Is My Mind', artist: 'Pixies' };
  const h = harness();
  const out = await run(h, {
    song: katerine, pickAnchor: norah, seen: seenOf(katerine, pixies),
    roots: q.neighbourArtistRoots(12), distances: q.neighbourArtistDistances(12),
  });
  assert.equal(out.kind, 'kept', 'Pixies was heard one slot ago, nearer than Katerine at three');
  assert.equal(h.events.at(-1)?.swapped, undefined);
  assert.deepEqual(h.calls, { repick: 0, poolRescue: 0 });
}));

// #1983 folds an in-word hyphen in artistRootKey. The distances key the same
// raw credits the window does, so "SCSI-9" is the "SCSI 9" two slots back: read
// as never heard (Infinity), it would out-rank every candidate in the window.
test('the swap reads a hyphenated credit as the spaced act in the window (#1983)', () => staged({
  upcoming: [{ track: { id: 'u1', artist: 'Norah Jones' } }],
  current: { track: { id: 'c1', artist: 'SCSI 9' } },
  plays: [play('p1', 'Air')],
}, () => {
  const d = q.neighbourArtistDistances(12);
  const scsi: Cand = { id: 's1', title: 'Spiral', artist: 'SCSI-9' };
  assert.equal(creditDistance(scsi, d), 2);
  assert.ok(q.neighbourArtistRoots(12).has(artistRootKey(scsi)), 'the window agrees');
  const best = leastRecentAlternative(seenOf(scsi, air), norah, d, '');
  assert.equal(best?.song.artist, 'Air', 'three slots back beats SCSI-9 at two');
}));

test('queue.neighbourArtistDistances: queue tail first, then on air, then plays newest first', () => staged({
  upcoming: [{ track: { id: 'u1', artist: 'Zero 7' } }, { track: { id: 'u2', artist: 'Norah Jones' } }],
  current: { track: { id: 'c1', artist: 'Katerine' } },
  plays: [
    { id: 'p1', title: 'One', artist: 'Bebel Gilberto' },
    { id: 'p1', title: 'One', artist: 'Bebel Gilberto' }, // a duplicate row is one play
    { id: 'p2', title: 'Two', artist: 'Air' },
    { id: 'p3', title: 'Three', artist: 'Zero 7' },
  ],
}, () => {
  const d = q.neighbourArtistDistances(12);
  assert.equal(d.get(artistRootKey('Norah Jones')), 1);
  assert.equal(d.get(artistRootKey('Zero 7')), 2, 'nearest occurrence wins');
  assert.equal(d.get(artistRootKey('Katerine')), 3);
  assert.equal(d.get(artistRootKey('Bebel Gilberto')), 4);
  assert.equal(d.get(artistRootKey('Air')), 5);
  // No act index here, so every credit is its lead: the same acts as the
  // window the guard tests against (the superset case is below).
  assert.deepEqual(new Set(d.keys()), q.neighbourArtistRoots(12));
  // A window shorter than the queue keeps the queue's tail end, as the guard's does.
  assert.deepEqual([...q.neighbourArtistDistances(1)], [
    [artistRootKey('Norah Jones'), 1], [artistRootKey('Katerine'), 2], [artistRootKey('Bebel Gilberto'), 3],
  ]);
  assert.deepEqual(q.neighbourArtistRoots(1), new Set(q.neighbourArtistDistances(1).keys()));
  assert.equal(q.neighbourArtistDistances(0).size, 0, 'window off: no distances');
}));

test('queue.neighbourArtistDistances: every credit\'s acts count, a superset of the guard\'s roots', () => {
  // With the library's act index, a tail act counts (recency.creditedActKeys).
  // The roots key only the FIRST credit per lead act, so Karan Aujla on air is
  // in the distances alone; the swap needs every candidate in the roots, so an
  // extra key can only make a distance nearer.
  setKnownActsProvider(() => new Set(['daljit chahal', 'amantej hundal', 'karan aujla']));
  return staged({
    upcoming: [{ track: { id: 'u1', artist: 'Daljit Chahal & Amantej Hundal' } }],
    current: { track: { id: 'c1', artist: 'Daljit Chahal & Karan Aujla' } },
    plays: [],
  }, () => {
    const d = q.neighbourArtistDistances(12);
    const roots = q.neighbourArtistRoots(12);
    assert.deepEqual([...roots], ['daljit chahal', 'amantej hundal']);
    assert.deepEqual([...d], [['daljit chahal', 1], ['amantej hundal', 1], ['karan aujla', 2]]);
    for (const key of roots) assert.ok(d.has(key), `${key} has a distance`);
  }).finally(() => setKnownActsProvider(null));
});
