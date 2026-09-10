// runArtistGuard — the WIRING between the guard's decisions (issue #1406).
//
// artist-guard.test.ts pins the pieces: which cause fires, and which candidates
// a re-pick may choose from. This file pins how they are composed — which is
// where the two causes actually diverge, and the half that was previously only
// verifiable by reading, because it lived inline in pickViaAgent behind a model
// call.
//
// What it must hold:
//   - a pick-anchor match keeps the whole #1187 cascade
//     (re-pick → pool rescue → relax)
//   - spacing NEVER reaches the pool rescue and never spends a second model call
//     once its own re-pick has failed — it yields to the run instead
//   - a rescued slot reports back as filled, so the caller stops working on it
//   - every relaxation is logged, so a repeat on air is never silent
//
// The two expensive calls are injected, so there is no model, no queue and no
// settings here — counting the calls IS the assertion for the cost half.
//
// Run: npm test -- artist-guard-run

import assert from 'node:assert/strict';
import test from 'node:test';
import { runArtistGuard, artistRootKey } from '../src/broadcast/dj-agent/artist-guard.js';

type Cand = { id: string; title: string; artist: string };

const marvin: Cand = { id: 'm1', title: 'Heavy Love Affair', artist: 'Marvin Gaye' };
const marvinTammi: Cand = { id: 'm2', title: 'Ain\'t No Mountain', artist: 'Marvin Gaye & Tammi Terrell' };
const clash: Cand = { id: 'c1', title: 'Clampdown', artist: 'The Clash' };
const sly: Cand = { id: 's1', title: 'Fun', artist: 'Sly & the Family Stone' };
const beatles: Cand = { id: 'b1', title: 'Ob-La-Di', artist: 'The Beatles' };

const seenOf = (...songs: Cand[]) => new Map(songs.map((s) => [s.id, s]));
const rootsOf = (...names: string[]) => new Set(names.map((n) => artistRootKey(n)));

// A harness that records every injected call and every line logged, so a test
// can assert on what the guard SPENT as well as what it decided.
function harness(opts: {
  repick?: (alt: Map<string, Cand>, reason: string) => Cand | null;
  poolRescue?: 'queued' | 'empty' | 'collision';
} = {}) {
  const calls = { repick: 0, poolRescue: 0 };
  const reasons: string[] = [];
  const rescueArgs: string[] = [];
  const lines: string[] = [];
  const events: Record<string, unknown>[] = [];
  return {
    calls, reasons, rescueArgs, lines, events,
    deps: {
      repick: async (alt: Map<string, Cand>, reason: string) => {
        calls.repick++;
        reasons.push(reason);
        const chosen = opts.repick ? opts.repick(alt, reason) : [...alt.values()][0] ?? null;
        return chosen ? { id: chosen.id } : null;
      },
      poolRescue: async (avoidArtist: string) => {
        calls.poolRescue++;
        rescueArgs.push(avoidArtist);
        return opts.poolRescue ?? 'empty';
      },
      log: (line: string) => { lines.push(line); },
      logEvent: (_name: string, payload: Record<string, unknown>) => { events.push(payload); },
    },
  };
}

const run = (
  h: ReturnType<typeof harness>,
  o: { song: Cand; pickAnchor: Cand | null; seen: Map<string, Cand>; recentRoots?: Set<string>; window?: number },
) => runArtistGuard<Cand>({
  song: o.song,
  object: { id: o.song.id, say: 'a line' },
  pickAnchor: o.pickAnchor,
  seen: o.seen,
  recentRoots: o.recentRoots ?? new Set(),
  window: o.window ?? 5,
  ...h.deps,
});

// ── the guard stays out of the way ─────────────────────────────────────────

test('an unguarded pick costs nothing and changes nothing', async () => {
  const h = harness();
  const out = await run(h, { song: clash, pickAnchor: marvin, seen: seenOf(clash, sly), recentRoots: rootsOf('Marvin Gaye') });
  assert.equal(out.kind, 'none');
  assert.deepEqual(h.calls, { repick: 0, poolRescue: 0 }, 'no model call, no pool call');
  assert.deepEqual(h.lines, [], 'and nothing in the booth log');
});

// ── pick-anchor match: the #1124/#1187 cascade, unchanged ──────────────────

test('a pick-anchor match re-picks from the run when it can', async () => {
  const h = harness();
  const out = await run(h, { song: marvin, pickAnchor: marvin, seen: seenOf(marvin, clash, sly) });
  assert.equal(out.kind, 'repicked');
  assert.notEqual(out.kind === 'repicked' && artistRootKey(out.song), artistRootKey(marvin));
  assert.equal(h.calls.poolRescue, 0, 'a landed re-pick never reaches the pool');
  assert.match(h.reasons[0], /pick cycle is anchored to/, 'the model names the captured anchor');
  assert.doesNotMatch(h.reasons[0], /immediately preceding|twice in a row|already on air/,
    'the prompt makes no claim that the anchor is still adjacent or on air');
});

test('a held pair-drain pick anchor triggers anchor wording without claiming adjacency or on-air state', async () => {
  const heads: Cand = { id: 'heads', title: "Heads We're Dancing", artist: 'Kate Bush' };
  const rejected: Cand = { id: 'rejected', title: 'Running Up That Hill', artist: 'Kate Bush' };
  const tea: Cand = { id: 'tea', title: 'Tea for Two', artist: 'Bill Stegmeyer and his Hot Eight' };
  const h = harness({ repick: () => tea });

  const out = await run(h, {
    song: rejected,
    pickAnchor: heads,
    seen: seenOf(rejected, tea),
    recentRoots: rootsOf('Kate Bush'),
  });

  assert.equal(out.kind, 'repicked');
  assert.equal(out.kind === 'repicked' && out.song.id, 'tea');
  assert.match(h.reasons[0], /pick cycle is anchored to/);
  assert.doesNotMatch(h.reasons[0], /immediately preceding|twice in a row|already on air/);
  assert.equal(h.events[0].cause, 'onair', 'the compatibility telemetry value is preserved');
  assert.equal(h.events[0].basis, 'pick-anchor', 'telemetry states what the legacy cause actually means');
});

test('a pick-anchor match with a single-artist run escalates to the pool, and a queued rescue fills the slot', async () => {
  const h = harness({ poolRescue: 'queued' });
  // The #1187 false negative: the run surfaced only the anchor artist (and the
  // collaboration they front, which is the same act) — that is NOT evidence
  // that the library has no one else.
  const out = await run(h, { song: marvin, pickAnchor: marvin, seen: seenOf(marvin, marvinTammi) });
  assert.equal(out.kind, 'rescued', 'a rescued slot is a filled slot');
  assert.equal(h.calls.repick, 0, 'nothing to re-pick from');
  assert.deepEqual(h.rescueArgs, ['Marvin Gaye'], 'the pool is told which artist to avoid');
});

test('a pick-anchor match relaxes — loudly — only once the pool has nothing either', async () => {
  const h = harness({ poolRescue: 'empty' });
  const out = await run(h, { song: marvin, pickAnchor: marvin, seen: seenOf(marvin) });
  assert.equal(out.kind, 'kept');
  assert.equal(h.calls.poolRescue, 1);
  assert.equal(h.events.at(-1)?.relaxed, true, 'a repeat on air is never silent');
  assert.match(h.lines.at(-1)!, /relaxed/);
});

test('a failed pick-anchor re-pick still escalates to the pool', async () => {
  // The model was offered alternatives and declined to answer with one. For
  // an anchor match that is not the end of the cascade.
  const h = harness({ repick: () => null, poolRescue: 'queued' });
  const out = await run(h, { song: marvin, pickAnchor: marvin, seen: seenOf(marvin, clash) });
  assert.equal(out.kind, 'rescued');
  assert.deepEqual(h.calls, { repick: 1, poolRescue: 1 });
});

test('a re-pick answering with an id it was not offered is refused', async () => {
  // z.enum constrains this by construction; the guard reads the id back out of
  // the NARROW map so it stays true if the schema ever loosens.
  const h = harness({ repick: () => beatles, poolRescue: 'empty' });
  const out = await run(h, { song: marvin, pickAnchor: marvin, seen: seenOf(marvin, clash) });
  assert.equal(out.kind, 'kept', 'an off-list id is not a re-pick');
  assert.equal(h.calls.poolRescue, 1, 'and is treated as a failed re-pick');
});

// ── spacing: the #1406 cause, and the ways it must stay cheap ──────────────

test('a pick inside the window is re-picked away from — the reported bug', async () => {
  // Legal under the old guard: Marvin is not on air, he played three slots ago.
  const h = harness();
  const out = await run(h, {
    song: marvin, pickAnchor: beatles, seen: seenOf(marvin, sly),
    recentRoots: rootsOf('The Beatles', 'Marvin Gaye', 'The Clash'),
  });
  assert.equal(out.kind, 'repicked');
  assert.equal(out.kind === 'repicked' && out.song.id, 's1', 'and it lands on the one fresh artist');
  assert.match(h.reasons[0], /last few slots/, 'told in the SPACING wording, not the pick-anchor one');
  assert.equal(h.calls.poolRescue, 0);
});

test('spacing yields when every alternative is also recent — no calls at all', async () => {
  const h = harness();
  const out = await run(h, {
    song: marvin, pickAnchor: beatles, seen: seenOf(marvin, sly),
    recentRoots: rootsOf('Marvin Gaye', 'Sly & the Family Stone'),
  });
  assert.equal(out.kind, 'kept', 'the original pick stands');
  assert.deepEqual(h.calls, { repick: 0, poolRescue: 0 }, 'spacing never buys latency it cannot spend');
  assert.equal(h.events.at(-1)?.reason, 'all-recent');
  assert.match(h.lines.at(-1)!, /no fresher artist/);
});

test('spacing yields on a single-artist run without touching the pool', async () => {
  const h = harness({ poolRescue: 'queued' });
  const out = await run(h, {
    song: marvin, pickAnchor: beatles, seen: seenOf(marvin, marvinTammi),
    recentRoots: rootsOf('Marvin Gaye'),
  });
  assert.equal(out.kind, 'kept');
  assert.deepEqual(h.calls, { repick: 0, poolRescue: 0 });
  assert.equal(h.events.at(-1)?.reason, 'no-other-artist');
});

test('a failed spacing re-pick keeps the pick and stops — this is the cost guarantee', async () => {
  // The one that would silently regress into a second model call per pick if
  // the two causes were ever merged back together.
  const h = harness({ repick: () => null, poolRescue: 'queued' });
  const out = await run(h, {
    song: marvin, pickAnchor: beatles, seen: seenOf(marvin, sly),
    recentRoots: rootsOf('Marvin Gaye'),
  });
  assert.equal(out.kind, 'kept');
  assert.equal(h.calls.repick, 1, 'it tried once');
  assert.equal(h.calls.poolRescue, 0, 'and never escalated a preference to the pool');
  assert.equal(h.events.at(-1)?.reason, 'repick-failed');
});

// ── the two fixes are one mechanism ────────────────────────────────────────

test('a name variant of the anchor act is caught as a pick-anchor match', async () => {
  // The reported bypass: "The Jimi Hendrix Experience" straight into "Jimi
  // Hendrix". Different raw tags, one artist — and before #1406 the guard was
  // blind to it because the root keys differed.
  const hendrixBand: Cand = { id: 'h1', title: 'Foxy Lady', artist: 'The Jimi Hendrix Experience' };
  const hendrixSolo: Cand = { id: 'h2', title: 'Angel', artist: 'Jimi Hendrix' };
  const h = harness();
  const out = await run(h, { song: hendrixSolo, pickAnchor: hendrixBand, seen: seenOf(hendrixSolo, clash) });
  assert.equal(out.kind, 'repicked');
  assert.equal(out.kind === 'repicked' && out.song.id, 'c1');
});

test('the window is off but a pick-anchor match still guards — 0 is not "no guard"', async () => {
  const h = harness();
  const spaced = await run(h, { song: marvin, pickAnchor: beatles, seen: seenOf(marvin, sly), recentRoots: new Set(), window: 0 });
  assert.equal(spaced.kind, 'none', 'spacing is off');

  const adjacent = await run(h, { song: marvin, pickAnchor: marvin, seen: seenOf(marvin, sly), recentRoots: new Set(), window: 0 });
  assert.equal(adjacent.kind, 'repicked', 'pick-anchor protection is not operator-disableable');
});

test('an untagged pick is never guarded on either cause', async () => {
  const untagged: Cand = { id: 'u1', title: 'Unknown', artist: '' };
  const h = harness();
  const out = await run(h, { song: untagged, pickAnchor: marvin, seen: seenOf(untagged, marvin), recentRoots: rootsOf('Marvin Gaye') });
  assert.equal(out.kind, 'none', 'no artist is not evidence of a repeat');
});

// ── telemetry ──────────────────────────────────────────────────────────────

test('every firing names its cause and window, so the two are separable in the log', async () => {
  const h = harness();
  await run(h, { song: marvin, pickAnchor: marvin, seen: seenOf(marvin, clash) });
  assert.equal(h.events[0].cause, 'onair');
  assert.equal(h.events[0].basis, 'pick-anchor');

  const h2 = harness();
  await run(h2, {
    song: marvin, pickAnchor: beatles, seen: seenOf(marvin, sly),
    recentRoots: rootsOf('Marvin Gaye'), window: 9,
  });
  assert.equal(h2.events[0].cause, 'recent');
  assert.equal(h2.events[0].basis, 'recent-window');
  assert.equal(h2.events[0].window, 9, 'the configured window rides the event');
});
