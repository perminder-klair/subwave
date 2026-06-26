// Regression test for the queue dedup guard (issue #619 + the #538 guarantee).
// Run: `tsx scripts/request-dedup.test.ts`.
//
// #538 scoped queue.push()'s dedup to aiPicked picks so listener requests
// never got a silent drop. #619 showed two concurrent listener requests
// resolving to the same song over the slow identify/match window both reach
// push() and queue the track twice (back-to-back replay), because each read
// queuedIds() before the other inserted. The fix broadens the guard to all
// pushes (atomic check-and-insert in push() — no await between the .some()
// test and upcoming.push()), with an allowDuplicate opt-out for explicit
// operator actions. These asserts pin every branch of that behaviour.
//
// node:assert-via-tsx style, matching scripts/picker-recency-regression.ts.

import assert from 'node:assert/strict';
import { queue } from '../src/broadcast/queue.js';

// Neutralise the real side effects of push(): persist() debounces a JSON write
// and drainToLiquidsoap() renders TTS + writes the handoff file Liquidsoap
// polls. Neither is part of the dedup contract under test, and both would
// touch disk / block on a poll timeout in a bare test process.
(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

function reset() {
  queue.upcoming = [];
  queue.current = null;
}

const trackX = { id: 'song-X', title: 'Track X', artist: 'Artist X' };
const trackY = { id: 'song-Y', title: 'Track Y', artist: 'Artist Y' };

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    reset();
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

async function main() {
  console.log('queue dedup guard (#619 / #538):');

  await test('two CONCURRENT listener requests for the same track → one queued, second deduped (#619)', async () => {
    // Fire both pushes "in parallel". push() runs its critical section
    // synchronously to the return, so the second observes the first's insert.
    const [a, b] = await Promise.all([
      queue.push({ track: trackX, requestedBy: 'alice' }),
      queue.push({ track: trackX, requestedBy: 'bob' }),
    ]);
    assert.equal(a, 1, 'first request should queue at position 1');
    assert.equal(b, -1, 'second request should be deduped (-1)');
    assert.equal(queue.upcoming.length, 1, 'only one copy should be in the queue');
  });

  await test('sequential listener requests for the same track also dedup', async () => {
    const a = await queue.push({ track: trackX, requestedBy: 'alice' });
    const b = await queue.push({ track: trackX, requestedBy: 'bob' });
    assert.equal(a, 1);
    assert.equal(b, -1);
    assert.equal(queue.upcoming.length, 1);
  });

  await test('a request for the CURRENTLY-PLAYING track is deduped', async () => {
    queue.current = { track: trackX };
    const b = await queue.push({ track: trackX, requestedBy: 'bob' });
    assert.equal(b, -1, 'requesting the on-air track should dedup');
    assert.equal(queue.upcoming.length, 0);
  });

  await test('distinct tracks are NOT deduped', async () => {
    const a = await queue.push({ track: trackX, requestedBy: 'alice' });
    const b = await queue.push({ track: trackY, requestedBy: 'bob' });
    assert.equal(a, 1);
    assert.equal(b, 2);
    assert.equal(queue.upcoming.length, 2);
  });

  await test('allowDuplicate (operator studio queue-track) bypasses the guard', async () => {
    const a = await queue.push({ track: trackX, requestedBy: 'studio' });
    const b = await queue.push({ track: trackX, requestedBy: 'studio', allowDuplicate: true });
    assert.equal(a, 1);
    assert.equal(b, 2, 'explicit operator action should always queue');
    assert.equal(queue.upcoming.length, 2);
  });

  await test('aiPicked picks are still deduped (#538 unchanged)', async () => {
    const a = await queue.push({ track: trackX, aiPicked: true });
    const b = await queue.push({ track: trackX, aiPicked: true });
    assert.equal(a, 1);
    assert.equal(b, -1);
  });

  await test('a track with no id is never deduped (guard requires track.id)', async () => {
    const noId = { title: 'No Id', artist: 'Anon' };
    const a = await queue.push({ track: noId, requestedBy: 'alice' });
    const b = await queue.push({ track: noId, requestedBy: 'bob' });
    assert.equal(a, 1);
    assert.equal(b, 2, 'without an id there is nothing to match on — both queue');
  });

  await test('dedupAck distinguishes on-air from already-queued', async () => {
    queue.current = { track: trackX };
    queue.upcoming = [{ track: trackY }];
    const onAir = queue.dedupAck('song-X');
    const queued = queue.dedupAck('song-Y');
    assert.match(onAir, /spinning right now/i, 'on-air track should read as playing now');
    assert.match(queued, /already queued|on the way/i, 'queued track should read as on the way');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall request-dedup tests passed');
  process.exit(0);
}

void main();
