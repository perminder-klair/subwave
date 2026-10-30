// The station list's live dot reads /now-playing with the station's saved
// Station login (#2143), so a station whose proxy guards /api shows on air
// instead of offline. A keychain failure probes with no login, as before.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { liveStatusClient } from '../src/lib/live-status.ts';
import { authorizationFor, type StationCredentials } from '../src/lib/station-credentials.ts';

const URL_ = 'https://radio.example';
const LOGIN: StationCredentials = { username: 'dj', password: 'p@ss:word' };
const BASIC = authorizationFor(LOGIN);

/** A Basic Auth proxy in front of /api: 401 with a challenge unless the
 *  request carries the login. Records what each request sent. */
function guardedStation(t: TestContext): { url: string; authorization: string | null }[] {
  const sent: { url: string; authorization: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization');
    sent.push({ url: String(input), authorization });
    if (authorization !== BASIC) {
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="radio"' } });
    }
    return Response.json({ streamOnline: true, nowPlaying: { artist: 'Aphex Twin', title: 'Flim' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return sent;
}

test("a station's saved login reaches the probe as a header, so its guarded /api answers", async (t) => {
  const sent = guardedStation(t);
  const api = await liveStatusClient(URL_, async () => LOGIN);
  const np = await api.nowPlaying();
  assert.equal(np.streamOnline, true);
  assert.deepEqual(sent, [{ url: `${URL_}/api/now-playing`, authorization: BASIC }]);
});

test('a station with no saved login probes with none', async (t) => {
  const sent = guardedStation(t);
  const api = await liveStatusClient(URL_, async () => null);
  await assert.rejects(api.nowPlaying(), /401/);
  assert.deepEqual(sent, [{ url: `${URL_}/api/now-playing`, authorization: null }]);
});

test('a keychain that cannot be read probes with no login instead of failing', async (t) => {
  const sent = guardedStation(t);
  const api = await liveStatusClient(URL_, async () => {
    throw new Error('keychain locked');
  });
  await assert.rejects(api.nowPlaying(), /401/);
  assert.deepEqual(sent, [{ url: `${URL_}/api/now-playing`, authorization: null }]);
});
