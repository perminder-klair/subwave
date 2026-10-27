// "Request a song" from Siri (src/intents/request-reply.ts): what Siri says for
// each thing the station can answer, and that a slow match never keeps Siri
// waiting past the cap.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCEPTED_MESSAGE,
  askForSong,
  REQUEST_WAIT_MS,
  spokenAnswer,
} from '../src/intents/request-reply.ts';
import type { RequestResult } from '../src/lib/types.ts';

/** A station whose POST answers `posted` and whose polls answer `polls` in
 *  turn, the last one repeating. A fake clock advances on every sleep. */
function station(posted: RequestResult | Error, polls: RequestResult[] = []) {
  let t = 0;
  const sent: string[] = [];
  let pollCount = 0;
  return {
    sent,
    get pollCount() {
      return pollCount;
    },
    deps: {
      api: {
        postRequest: async (body: { text: string }) => {
          sent.push(body.text);
          if (posted instanceof Error) throw posted;
          return posted;
        },
        pollRequest: async () => {
          pollCount += 1;
          return polls[Math.min(pollCount - 1, polls.length - 1)];
        },
      },
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
    },
  };
}

const accepted: RequestResult = { success: true, requestId: 'r1', status: 'pending' };

test('a matched request is answered with the DJ’s own acknowledgement', async () => {
  const s = station(accepted, [
    { success: false, status: 'pending' },
    {
      success: true,
      status: 'resolved',
      outcome: 'matched',
      ack: 'Teardrop, coming right up.',
      track: { title: 'Teardrop', artist: 'Massive Attack' },
    },
  ]);
  const reply = await askForSong('  teardrop by massive attack ', s.deps);
  assert.deepEqual(reply, { ok: true, message: 'Teardrop, coming right up.' });
  assert.deepEqual(s.sent, ['teardrop by massive attack']);
  assert.equal(s.pollCount, 2);
});

test('without an acknowledgement, the drawer’s label names the track', () => {
  const track = { title: 'Teardrop', artist: 'Massive Attack' };
  assert.equal(spokenAnswer({ success: true, outcome: 'matched', track }), 'Queued: Teardrop by Massive Attack.');
  assert.equal(
    spokenAnswer({ success: true, outcome: 'cooldown', track }),
    'Played recently: Teardrop by Massive Attack.',
  );
  assert.equal(spokenAnswer({ success: true, outcome: 'matched', track: { title: 'Teardrop' } }), 'Queued: Teardrop.');
});

test('a station refusal is passed on in the station’s own words', async () => {
  const closed = station({ success: false, message: 'Requests are temporarily closed.' });
  assert.deepEqual(await askForSong('anything', closed.deps), {
    ok: false,
    message: 'Requests are temporarily closed.',
  });

  // A 400 carries `error`, not `message`.
  const unreadable = station({ success: false, error: 'Empty request' } as RequestResult);
  assert.deepEqual(await askForSong('anything', unreadable.deps), { ok: false, message: 'Empty request' });
});

test('a failed match and an unreachable station are errors', async () => {
  const noMatch = station(accepted, [{ success: false, status: 'failed', outcome: 'no-match' }]);
  assert.deepEqual(await askForSong('zzz', noMatch.deps), {
    ok: false,
    message: 'No match — try different words.',
  });

  const offline = station(new Error('network'));
  const reply = await askForSong('anything', offline.deps);
  assert.equal(reply.ok, false);
});

test('a slow match stops polling at the cap and says the request is in', async () => {
  const s = station(accepted, [{ success: false, status: 'pending' }]);
  assert.deepEqual(await askForSong('something slow', s.deps), { ok: true, message: ACCEPTED_MESSAGE });
  assert.ok(s.pollCount > 0);
  assert.ok(s.pollCount <= Math.ceil(REQUEST_WAIT_MS / 1500));
});

test('a request the station lost stops polling at once', async () => {
  const s = station(accepted, [{ success: false, status: 'unknown' }]);
  assert.deepEqual(await askForSong('anything', s.deps), { ok: true, message: ACCEPTED_MESSAGE });
  assert.equal(s.pollCount, 1);
});

test('an empty request never reaches the station', async () => {
  const s = station(accepted);
  const reply = await askForSong('   ', s.deps);
  assert.equal(reply.ok, false);
  assert.deepEqual(s.sent, []);
});
