// Regression test for the stale back-announce safety-net (shouldDropStaleLink).
// Run: `tsx scripts/stale-link.test.ts`.
//
// Auto-pick links are written FORWARD-LOOKING: they introduce the track now
// starting and never name the just-played track (see llm prompts + dj-agent
// linkClause). That's because the link is rendered when the pick is made but
// doesn't air until the pick actually starts, and a listener request can slip
// ahead of the pick in between — so what "just played" isn't certain. A
// forward-looking line is correct whatever aired before it, so it always airs.
//
// shouldDropStaleLink is a precise SAFETY-NET for the model disobeying that
// instruction: it drops a link ONLY when the rendered text actually NAMES a
// predecessor (`linkPrev`) that is NOT what really played just before it. These
// asserts pin every branch — crucially, that a forward-looking link is NEVER
// suppressed (no silent hand-off) even when a request jumped ahead.
//
// node:assert-via-tsx style, matching scripts/request-dedup.test.ts.

import assert from 'node:assert/strict';
import { shouldDropStaleLink } from '../src/broadcast/queue.js';

const X = { id: 'song-X', title: 'Track Xenon', artist: 'Artist X' };
const R = { id: 'song-R', title: 'Request Rondo', artist: 'Artist R' };

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

function main() {
  console.log('stale back-announce safety-net (shouldDropStaleLink):');

  test('no linkPrev (request intro never back-announces) → always airs', () => {
    assert.equal(shouldDropStaleLink({ linkPrev: null, introScript: 'anything' }, R), false);
    assert.equal(shouldDropStaleLink({ introScript: 'anything' }, R), false);
    assert.equal(shouldDropStaleLink({ linkPrev: null }, null), false);
  });

  test('forward-looking link (does NOT name the previous track) → airs even when a request jumped ahead', () => {
    // The whole point: a request bumped X out of the just-played slot (predecessor
    // is R), but the line never names X, so there is nothing stale to drop — it airs.
    assert.equal(
      shouldDropStaleLink({ linkPrev: X, introScript: "Here's a fresh one coming up for you now" }, R),
      false,
    );
  });

  test('link that NAMES the previous track + a request jumped ahead → dropped', () => {
    assert.equal(
      shouldDropStaleLink({ linkPrev: X, introScript: 'That was Track Xenon — now something new' }, R),
      true,
    );
  });

  test('names the previous track by ARTIST (not title) + request jumped ahead → dropped', () => {
    assert.equal(
      shouldDropStaleLink({ linkPrev: X, introScript: 'That was Artist X for you' }, R),
      true,
    );
  });

  test('link names the previous track but it IS what just played (common case) → airs', () => {
    assert.equal(
      shouldDropStaleLink({ linkPrev: X, introScript: 'That was Track Xenon' }, X),
      false,
    );
  });

  test('predecessor matched by id even when its title drifts (re-tag) → airs', () => {
    const sameIdNewTitle = { id: 'song-X', title: 'Track Xenon (Remaster)', artist: 'Artist X' };
    assert.equal(
      shouldDropStaleLink({ linkPrev: X, introScript: 'That was Track Xenon' }, sameIdNewTitle),
      false,
    );
  });

  test('id-less auto-playlist predecessor falls back to title match', () => {
    const prevNoId = { id: null, title: 'Track Xenon', artist: 'Artist X' };
    assert.equal(
      shouldDropStaleLink({ linkPrev: { id: null, title: 'Track Xenon', artist: 'Artist X' }, introScript: 'That was Track Xenon' }, prevNoId),
      false,
    );
  });

  test('short/common titles (<4 chars) do not trigger an incidental match', () => {
    const shortPrev = { id: 'song-OK', title: 'OK', artist: 'U2' };
    // "ok" and "u2" appear incidentally but are too short to count as naming it.
    assert.equal(
      shouldDropStaleLink({ linkPrev: shortPrev, introScript: 'OK everyone, here we go' }, R),
      false,
    );
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall stale-link tests passed');
  process.exit(0);
}

main();
