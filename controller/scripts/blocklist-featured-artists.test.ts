// Regression test for issue #1603: blocking an artist must also block the
// tracks they only GUEST on. Before this, the blocklist's artist tiers saw one
// act per row — a song carries a single `artistId` (its lead) and the name
// fallback compared the whole credit string — so "Y feat. X" airs after X is
// blocked and the operator has to block those tracks one by one.
//
// Four things are pinned here, and the middle two are the point:
//   1. recency.artistParticipantKeys splits a credit into its acts.
//   2. It splits on `feat.`/`ft.`/`featuring` and NOTHING else. `&`, `+`, `,`
//      and `x` live inside real act names, and this list is absolute (no
//      never-starve anywhere, requests included), so a wrong key removes music
//      the operator never blocked. The named bands below are the collateral.
//   3. The WHOLE credit is still matched, beside the acts in it. A stored entry
//      name is a display CREDIT, not an artist's name — POST /library/blocklist
//      resolves an artist block from a track row as `{ id: song.artistId,
//      name: song.artist }` — so blocking "this artist" on a "Host feat. Guest"
//      row persists the composite, which no participant key can ever equal.
//      Matching acts alone stranded every such entry, and rows blocked before
//      the upgrade would have started airing again.
//   4. Both halves of the blocklist read the credit the same way — the id
//      entries' name fallback and the `field: 'artist'` rules — because
//      blocklist-rules documents its artist case AS the fallback's semantics.
//
// Run: `tsx scripts/blocklist-featured-artists.test.ts`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time, so EVERY
// src import here is dynamic and lives below the assignment. A static import of
// a module that looks pure today (recency, blocklist-rules) is one added import
// away from pulling config.js in ahead of this line — and this test writes a
// blocklist.json, so the failure mode is writing into the operator's real state
// dir rather than a red test.
const stateDir = mkdtempSync(join(tmpdir(), 'blocklist-feat-test-'));
process.env.STATE_DIR = stateDir;

const { artistNameKey, artistParticipantKeys } = await import('../src/music/recency.js');
const { compileRules, ruleMatches } = await import('../src/music/blocklist-rules.js');
type BlockRule = import('../src/music/blocklist-rules.js').BlockRule;
const blocklist = await import('../src/music/blocklist.js');

// ── The key helper ──────────────────────────────────────────────────────────

test('a feature credit splits into its acts, in credit order', () => {
  const cases: [string, string[]][] = [
    ['Kanye West (feat. Jay-Z)', ['kanye west', 'jay-z']],
    ['Kanye West [ft. Jay-Z]', ['kanye west', 'jay-z']],
    ['Drake ft Rihanna', ['drake', 'rihanna']],
    ['Daft Punk featuring Pharrell Williams', ['daft punk', 'pharrell williams']],
    ['  MARK RONSON   Feat.  Amy Winehouse ', ['mark ronson', 'amy winehouse']],
    // Curly and straight apostrophes are one act, the same fold artistRootKey
    // applies (#1406).
    ['Someone feat. Guns N’ Roses', ['someone', "guns n' roses"]],
    // Two markers in one credit: every segment is an act.
    ['A feat. B featuring C', ['a', 'b', 'c']],
    // The bracket cleanup drops the ORPHANED closer the split left behind, and
    // only that: the lead keeps the brackets that are part of its name, and a
    // balanced suffix on the tail keeps its own.
    ['Sunn O))) feat. Someone', ['sunn o)))', 'someone']],
    ['Sunn O))) (feat. Someone)', ['sunn o)))', 'someone']],
    ['X feat. Y (Live)', ['x', 'y (live)']],
  ];
  for (const [raw, want] of cases) {
    assert.deepEqual(artistParticipantKeys(raw), want, `"${raw}"`);
    assert.deepEqual(artistParticipantKeys({ artist: raw }), want, `"${raw}" (candidate form)`);
  }
});

test('nothing but a feature marker splits — real act names stay whole', () => {
  // Every one of these would be split by an `&` / `+` / `,` / `x` rule, and
  // each split is a band the operator never blocked disappearing from the
  // station with no starvation fallback to make the loss visible.
  const whole = [
    'Simon & Garfunkel',
    'Hall & Oates',
    'Florence + the Machine',
    'Earth, Wind & Fire',
    'Tyler, the Creator',
    'Chase & Status',
    'Crosby, Stills, Nash & Young',
    'Sly & the Family Stone',
    'AC/DC',
    // Brackets inside a name are part of the name — the orphan-closer cleanup
    // must not reach a credit that never split.
    'Sunn O)))',
    // Substrings of the markers are not markers.
    'Feature Cast',
    'Softly',
  ];
  for (const raw of whole) {
    assert.deepEqual(artistParticipantKeys(raw), [artistNameKey(raw)], `"${raw}" must key whole`);
  }
});

test('a marker at the front of a name is not a marker', () => {
  // `\bft\b\.?\s+` matches the head of "Ft. Lauderdale …"; splitting there
  // would leave a key naming nobody. Same guard artistRootKey applies.
  assert.deepEqual(artistParticipantKeys('Ft. Lauderdale Sound'), ['ft. lauderdale sound']);
  assert.deepEqual(artistParticipantKeys(''), []);
  assert.deepEqual(artistParticipantKeys({ artist: null }), []);
});

// ── The id-entry name fallback ──────────────────────────────────────────────

test('blocking an artist blocks the tracks they are featured on', async () => {
  await blocklist.load();
  await blocklist.add({ type: 'artist', id: 'art-guest', name: 'Guest Act' });

  assert.equal(blocklist.isBlocked({ id: 's1', artist: 'Guest Act' }), true, 'the lead credit still matches');
  assert.equal(blocklist.isBlocked({ id: 's2', artist: 'Host Act feat. Guest Act' }), true);
  assert.equal(blocklist.isBlocked({ id: 's3', artist: 'Host Act (feat. Guest Act)' }), true);
  assert.equal(blocklist.isBlocked({ id: 's4', artist: 'Host Act ft. Guest Act' }), true);

  // The admin view has to say WHY a track vanished: the block is attributed to
  // the artist entry that caused it, not to the track.
  const hit = blocklist.hitOf({ id: 's2', artist: 'Host Act feat. Guest Act' });
  assert.deepEqual(hit, { kind: 'entry', type: 'artist', id: 'art-guest', name: 'Guest Act' });

  // Blocking the LEAD reaches its own feature credits too — the same gap in
  // the other direction, since the whole string never matched either.
  await blocklist.add({ type: 'artist', id: 'art-host', name: 'Host Act' });
  assert.equal(blocklist.isBlocked({ id: 's5', artist: 'Host Act feat. Someone Else' }), true);

  // A row two entries could claim resolves to the LEAD's — matchOf's ordering
  // contract is walked in credit order, so the answer can't wander per poll.
  assert.equal(blocklist.matchOf({ id: 's6', artist: 'Host Act feat. Guest Act' })?.id, 'art-host');

  await blocklist.remove('artist', 'art-host');
});

test('a band whose name contains a separator is not collateral', async () => {
  await blocklist.add({ type: 'artist', id: 'art-simon', name: 'Simon' });
  await blocklist.add({ type: 'artist', id: 'art-hall', name: 'Hall' });
  await blocklist.add({ type: 'artist', id: 'art-florence', name: 'Florence' });
  await blocklist.add({ type: 'artist', id: 'art-tyler', name: 'Tyler' });
  await blocklist.add({ type: 'artist', id: 'art-earth', name: 'Earth' });

  for (const artist of ['Simon & Garfunkel', 'Hall & Oates', 'Florence + the Machine', 'Tyler, the Creator', 'Earth, Wind & Fire']) {
    assert.equal(blocklist.isBlocked({ id: 'c1', artist }), false, `"${artist}" must stay playable`);
  }

  // Still exact within a participant — no substring matching crept in.
  assert.equal(blocklist.isBlocked({ id: 'c2', artist: 'Someone feat. Simon Says' }), false);
  assert.equal(blocklist.isBlocked({ id: 'c3', artist: 'Someone feat. Simon' }), true, 'the exact guest still matches');

  // The honest cost of refusing the join split: a block on one act inside a
  // multi-guest tail does not fire. Under-blocking, which the operator can see
  // and fix; over-blocking is the one they can't.
  assert.equal(blocklist.isBlocked({ id: 'c4', artist: 'Someone feat. Simon & Garfunkel' }), false);
});

test('an entry whose stored name is a feature credit still blocks that row', async () => {
  // This is the shape POST /library/blocklist actually persists: an artist
  // block resolved from a track row carries `name: song.artist`, the row's
  // display CREDIT, so "Never play this artist" on a featured row stores the
  // composite. No participant key can equal it, so matching acts ALONE would
  // strand the entry and un-block a row this station had already blocked.
  await blocklist.add({ type: 'artist', id: 'art-lead', name: 'Lead Act feat. Sideman' });
  assert.equal(
    blocklist.isBlocked({ id: 'w1', artist: 'Lead Act feat. Sideman' }),
    true,
    'the pre-#1603 whole-credit tier is still there',
  );

  // And it is the composite entry the badge names, not a participant entry
  // that could also claim the row: whole credit first is most-specific-first.
  await blocklist.add({ type: 'artist', id: 'art-sideman', name: 'Sideman' });
  assert.equal(blocklist.matchOf({ id: 'w2', artist: 'Lead Act feat. Sideman' })?.id, 'art-lead');

  // The wart the shape leaves behind, pinned so it is not mistaken for the fix:
  // a composite name is not a participant key, so that entry reaches only the
  // credit it was stored from. Blocking the guest properly needs an entry named
  // for the act (art-sideman), which is what the participant tier is for.
  assert.equal(blocklist.isBlocked({ id: 'w3', artist: 'Lead Act' }), false);
  assert.equal(blocklist.isBlocked({ id: 'w4', artist: 'Other feat. Lead Act' }), false);
  assert.equal(blocklist.isBlocked({ id: 'w5', artist: 'Other feat. Sideman' }), true);

  await blocklist.remove('artist', 'art-lead');
  await blocklist.remove('artist', 'art-sideman');
  assert.equal(blocklist.isBlocked({ id: 'w6', artist: 'Lead Act feat. Sideman' }), false);
});

// ── The rule half, which documents itself AS the fallback's semantics ───────

const artistRule = (values: string[]): BlockRule => ({
  id: 'r1', label: 'Blocked artist', field: 'artist', values,
  season: null, showIds: [], addedAt: '2026-01-01T00:00:00.000Z',
});

test('a field:artist rule reads a credit the same way', () => {
  const cr = compileRules([artistRule(['Guest Act'])])[0]!;
  assert.equal(ruleMatches(cr, { artist: 'Guest Act' }, null), true);
  assert.equal(ruleMatches(cr, { artist: 'Host Act feat. Guest Act' }, null), true);
  assert.equal(ruleMatches(cr, { artist: 'Guest Actor' }, null), false, 'exact only, no substring');

  const simon = compileRules([artistRule(['Simon'])])[0]!;
  assert.equal(ruleMatches(simon, { artist: 'Simon & Garfunkel' }, null), false);

  // Apostrophe variants fold on BOTH sides — a value typed with a straight
  // quote has to match a catalogue tagged with a curly one, and vice versa.
  const guns = compileRules([artistRule(["Guns N' Roses"])])[0]!;
  assert.equal(ruleMatches(guns, { artist: 'Guns N’ Roses' }, null), true);
  assert.equal(ruleMatches(guns, { artist: 'Someone feat. Guns N’ Roses' }, null), true);
});

test('a field:artist rule value that is itself a credit still matches', () => {
  // The rule half of the same trap: an operator pastes a credit off a track row
  // into a rule value. Matching acts alone would compile it to a key no track
  // can ever produce, and the rule's matchCount would quietly read 0.
  const cr = compileRules([artistRule(['Lead Act feat. Sideman'])])[0]!;
  assert.equal(ruleMatches(cr, { artist: 'Lead Act feat. Sideman' }, null), true);
  assert.equal(ruleMatches(cr, { artist: 'Lead Act' }, null), false);
  assert.equal(ruleMatches(cr, { artist: 'Sideman' }, null), false);
});

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
