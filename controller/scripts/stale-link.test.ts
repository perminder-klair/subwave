// Regression test for the stale back-announce guard (shouldDropStaleLink).
// Run: `tsx scripts/stale-link.test.ts`.
//
// A between-track DJ link is written as "that was X, here's this pick" against
// the track on-air when the pick was made (`linkPrev`), its WAV rendered ahead
// of time, then deferred until the pick actually airs (#189). That's valid only
// while the pick is still the immediately-next track. If a listener request
// slips into the queue ahead of the pick before it airs, the request plays in
// between — so the baked-in "that was X" would name a track one (or more) older
// than what actually just played. airIntro drops the link in that case rather
// than air a wrong name. These asserts pin every branch of that decision.
//
// node:assert-via-tsx style, matching scripts/request-dedup.test.ts.

import assert from 'node:assert/strict';
import { shouldDropStaleLink } from '../src/broadcast/queue.js';

const X = { id: 'song-X', title: 'Track X', artist: 'Artist X' };
const R = { id: 'song-R', title: 'Request R', artist: 'Artist R' };

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
  console.log('stale back-announce guard (shouldDropStaleLink):');

  test('no linkPrev (request intro never back-announces) → always airs', () => {
    assert.equal(shouldDropStaleLink({ linkPrev: null }, R), false);
    assert.equal(shouldDropStaleLink({}, R), false);
    assert.equal(shouldDropStaleLink({ linkPrev: null }, null), false);
  });

  test('link follows the track it names (common case) → airs', () => {
    // X played, picked a track with a link back-announcing X, X is what just
    // played → valid, air it.
    assert.equal(shouldDropStaleLink({ linkPrev: X }, X), false);
  });

  test('a request jumped ahead — predecessor is R, link names X → dropped', () => {
    assert.equal(shouldDropStaleLink({ linkPrev: X }, R), true);
  });

  test('matches by id even when titles drift (re-tagged metadata)', () => {
    const sameIdNewTitle = { id: 'song-X', title: 'Track X (Remaster)', artist: 'Artist X' };
    assert.equal(shouldDropStaleLink({ linkPrev: X }, sameIdNewTitle), false);
  });

  test('falls back to title when ids are absent (auto-playlist track)', () => {
    const prevNoId = { id: null, title: 'Track X', artist: 'Artist X' };
    const linkNoId = { id: null, title: 'Track X', artist: 'Artist X' };
    assert.equal(shouldDropStaleLink({ linkPrev: linkNoId }, prevNoId), false);
    const otherNoId = { id: null, title: 'Some Other Song', artist: 'Whoever' };
    assert.equal(shouldDropStaleLink({ linkPrev: linkNoId }, otherNoId), true);
  });

  test('title compare is case/space-insensitive', () => {
    const a = { id: null, title: 'Track X' };
    const b = { id: null, title: '  track x  ' };
    assert.equal(shouldDropStaleLink({ linkPrev: a }, b), false);
  });

  test('missing predecessor with a link present → dropped (cannot verify)', () => {
    assert.equal(shouldDropStaleLink({ linkPrev: X }, null), true);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall stale-link tests passed');
  process.exit(0);
}

main();
