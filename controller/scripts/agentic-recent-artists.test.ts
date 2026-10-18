// The Agentic pick event names the artists the guard would refuse. Without it
// the model saw only its own pick notes, proposed an artist from the window,
// and every refusal cost a second model call (seen live: one artist proposed
// four slots running on a playlist show). The named list must be the guard's
// own window, so the two are read from one walk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artistRootKey } from '../src/music/recency.js';
import { recentArtistsClause } from '../src/broadcast/dj-agent/artist-guard.js';
import { queue } from '../src/broadcast/queue.js';

function setQueue({ plays = [], current = null, upcoming = [] }: { plays?: any[]; current?: any; upcoming?: any[] }) {
  (queue as any)._recentPlays = plays;
  (queue as any).current = current;
  (queue as any).upcoming = upcoming;
}

test('the named credits are exactly the guard window, one per lead artist', () => {
  setQueue({
    upcoming: [{ track: { id: 'Q1', title: 'Queued', artist: 'Lizzo' } }],
    current: { track: { id: 'CUR', title: 'On Air', artist: 'Jazzy B & Kudlip Manak' } },
    plays: [
      { id: 'A', title: 'One', artist: 'Jazzy B', endedAt: '2026-10-14T12:00:00.000Z' },
      { id: 'B', title: 'Two', artist: 'Pitbull & Ne-Yo', endedAt: '2026-10-14T11:56:00.000Z' },
      { id: 'C', title: 'Three', artist: 'AP Dhillon', endedAt: '2026-10-14T11:52:00.000Z' },
    ],
  });
  const credits = queue.neighbourArtistCredits(2);
  assert.deepEqual(credits, ['Lizzo', 'Jazzy B & Kudlip Manak', 'Pitbull & Ne-Yo'],
    'queue tail, on-air, then plays; a second Jazzy B credit is folded into the first');
  assert.deepEqual(
    new Set(credits.map(c => artistRootKey(c))),
    queue.neighbourArtistRoots(2),
    'the guard set and the named list come from the same walk',
  );
  assert.ok(!credits.includes('AP Dhillon'), 'n=2 stops before the third distinct play');
});

test('an empty or zero window names nobody', () => {
  setQueue({ plays: [{ id: 'A', title: 'One', artist: 'Jazzy B', endedAt: '2026-10-14T12:00:00.000Z' }] });
  assert.deepEqual(queue.neighbourArtistCredits(0), []);
  assert.equal(queue.neighbourArtistRoots(0).size, 0);
  setQueue({ plays: [{ id: 'D', title: 'Untitled', artist: '', endedAt: '2026-10-14T12:00:00.000Z' }] });
  assert.deepEqual(queue.neighbourArtistCredits(3), [], 'an untagged play adds nothing');
});

test('the clause lists the credits and is absent when there are none', () => {
  assert.equal(recentArtistsClause([]), '');
  assert.equal(recentArtistsClause(['', '  ']), '');
  const clause = recentArtistsClause(['Jazzy B', 'Pitbull & Ne-Yo']);
  assert.match(clause, /^ Artists just played or already queued/);
  assert.match(clause, /choose someone else unless nothing else fits: Jazzy B; Pitbull & Ne-Yo\.$/,
    'joined on ";" so a credit with "&" or "," still reads as one act');
});
