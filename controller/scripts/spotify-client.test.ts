// The Spotify Web API client (music/sources/spotify/client.ts) against an
// injected fetch — no account, no network. What is pinned:
//   • token refresh happens lazily, once, and is shared by concurrent callers;
//   • a 401 triggers exactly ONE refresh-and-retry, a second 401 surfaces;
//   • a 429 is honoured once when Retry-After is within the cap, never beyond;
//   • a rotated refresh token and every fresh access token reach their sinks;
//   • no token ever appears in a log line;
//   • 204 / allow404 return null, other errors throw SpotifyApiError with the
//     endpoint and status;
//   • the POST-FEBRUARY-2026 endpoint surface at the wire — playlist contents
//     come from /items not /tracks, page sizes never exceed Spotify's caps,
//     search never asks for more than ten, and no call still sends the legacy
//     market=from_token. Each of those was a silent failure mode: /tracks 403s,
//     an over-asked page is trimmed and `paginate` reads the short page as the
//     last one, and from_token has nothing left to resolve against.
//
// Run: npm test -- spotify-client

import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotifyClient, SpotifyApiError, SpotifyAuthError, SpotifyRateLimitError, redactSpotify, SPOTIFY_SCOPES } from '../src/music/sources/spotify/client.js';

// The waits are policy, not duration — assert on what was requested, never
// spend the seconds.
const noSleep = async () => {};

type Step = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(script: Step[]) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch: ${url}`);
    // A raw string body goes out verbatim — that is how a removed endpoint
    // answers (an HTML error page, not JSON), and the client must survive it.
    const text = step.body === undefined ? '' : typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      statusText: `S${step.status}`,
      headers: { get: (k: string) => step.headers?.[k.toLowerCase()] ?? null },
      json: async () => (text ? JSON.parse(text) : {}),
      text: async () => text,
    } as any;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const creds = () => ({ clientId: 'id', clientSecret: 'secret', refreshToken: 'REFRESH_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789' });
const tokenOk = (tok = 'ACCESS_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789'): Step => ({ status: 200, body: { access_token: tok, expires_in: 3600 } });

test('refreshes lazily, once, and shares the in-flight refresh across callers', async () => {
  const { fetchImpl, calls } = fakeFetch([tokenOk(), { status: 200, body: { id: 'me' } }, { status: 200, body: { id: 'me' } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, now: () => 1_000_000 });
  const [a, b] = await Promise.all([c.getMe(), c.getMe()]);
  assert.equal((a as any).id, 'me');
  assert.equal((b as any).id, 'me');
  assert.equal(calls.filter((x) => x.url.includes('/api/token')).length, 1, 'one refresh for two concurrent calls');
  assert.equal(calls[0].init.headers.Authorization.startsWith('Basic '), true);
  assert.equal(String(calls[0].init.body), 'grant_type=refresh_token&refresh_token=REFRESH_TOKEN_abcdefghijklmnopqrstuvwxyz0123456789');
});

test('a 401 refreshes once and retries; a second 401 surfaces as SpotifyApiError', async () => {
  const { fetchImpl, calls } = fakeFetch([
    tokenOk('T1'), { status: 401, body: { error: { message: 'expired' } } },
    tokenOk('T2'), { status: 200, body: { ok: true } },
  ]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  const r = await c.api('/me');
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[3].init.headers.Authorization, 'Bearer T2');

  const second = fakeFetch([tokenOk('T1'), { status: 401, body: {} }, tokenOk('T2'), { status: 401, body: { error: { message: 'still bad' } } }]);
  const c2 = new SpotifyClient({ fetch: second.fetchImpl, credentials: creds });
  await assert.rejects(c2.api('/me'), (e: any) => e instanceof SpotifyApiError && e.status === 401 && /still bad/.test(e.message));
});

test('a 429 within the cap is waited out once; beyond the cap it surfaces', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 429, headers: { 'retry-after': '1' } }, { status: 200, body: { after: true } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, maxRetryAfterMs: 5000, sleep: noSleep });
  assert.deepEqual(await c.api('/search'), { after: true });

  const slow = fakeFetch([tokenOk(), { status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'rate' } } }]);
  const c2 = new SpotifyClient({ fetch: slow.fetchImpl, credentials: creds, maxRetryAfterMs: 1000, sleep: noSleep });
  await assert.rejects(c2.api('/search'), (e: any) => e instanceof SpotifyApiError && e.status === 429 && e.retryAfterMs > 0);
});

// The storm this whole gate exists to stop: the per-artist genre fill hit a long
// Retry-After, and because 429 handling was per-request, every remaining call
// went to the network to discover the same limit for itself.
test('one 429 closes the gate for EVERY other caller — a background call then sends no request at all', async () => {
  const { fetchImpl, calls } = fakeFetch([
    tokenOk(),
    { status: 429, headers: { 'retry-after': '600' }, body: { error: { message: 'API rate limit exceeded' } } },
  ]);
  const logs: string[] = [];
  let now = 1_000_000;
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, now: () => now, log: (l) => logs.push(l), sleep: noSleep });

  await assert.rejects(c.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  const spent = calls.length;
  assert.equal(c.rateLimitedForMs(), 600_000, 'the window is shared state, not per-request');

  // Fifty more background calls: not one of them may reach the network.
  for (let i = 0; i < 50; i++) {
    await assert.rejects(c.getArtist(`A${i}`, { background: true }), (e: any) => e instanceof SpotifyRateLimitError);
  }
  assert.equal(calls.length, spent, '50 doomed calls, zero requests');

  // A foreground call facing a 10-minute window gives up rather than stalling
  // the seam — the transport's own backoff is the better place to lose time.
  await assert.rejects(c.api('/me/player/play', { method: 'PUT' }), (e: any) => e instanceof SpotifyRateLimitError);
  assert.equal(calls.length, spent);

  assert.equal(logs.filter((l) => /rate limit/i.test(l)).length, 1, 'one line per window, not one per request');

  // …and it clears itself.
  now += 600_001;
  assert.equal(c.rateLimitedForMs(), 0);
});

// The regression this lane exists for: with only two lanes, a 1800s window made
// getDevices() throw before the network, play() resolves the device before every
// command, and the station went silent for the full half hour.
test('a CRITICAL call reaches the network while the gate is closed; background still does not', async () => {
  const { fetchImpl, calls } = fakeFetch([
    tokenOk(),
    { status: 429, headers: { 'retry-after': '1800' }, body: { error: { message: 'API rate limit exceeded' } } },
    { status: 200, body: { devices: [{ id: 'D1', name: 'SUB/WAVE' }] } },
    { status: 204 },
  ]);
  // Fixed clock: rateLimitedForMs() decays in real time, so an exact assertion
  // against a wall clock is a flake waiting to happen.
  const now = 1_000_000;
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, sleep: noSleep, now: () => now });

  // Close the gate with a background failure, as the genre fill does.
  await assert.rejects(c.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  assert.equal(c.rateLimitedForMs(), 1_800_000);
  const spent = calls.length;

  // Enrichment stays down…
  await assert.rejects(c.getArtist('A2', { background: true }), (e: any) => e instanceof SpotifyRateLimitError);
  assert.equal(calls.length, spent, 'background sent nothing');

  // …while the player calls go through, which is what keeps music on air.
  const devices: any = await c.getDevices();
  assert.equal(devices.devices[0].id, 'D1');
  await c.play({ deviceId: 'D1', uris: ['spotify:track:abc'] });
  assert.equal(calls.length, spent + 2, 'both player calls reached the network');
  assert.ok(calls[spent].url.includes('/me/player/devices'));
  assert.equal(c.rateLimitedForMs(), 1_800_000, 'and the window still stands for everyone else');
});

test('a critical call is not spaced by the background gap', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 204 }, { status: 204 }, { status: 204 }]);
  const slept: number[] = [];
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, backgroundGapMs: 500,
    sleep: async (ms) => { slept.push(ms); },
  });
  await c.pause('D1');
  await c.pause('D1');
  await c.pause('D1');
  assert.deepEqual(slept, [], 'three player commands, no spacing — the transport owns their pacing');
});

test('a foreground call waits out a SHORT window; background never waits', async () => {
  const { fetchImpl, calls } = fakeFetch([
    tokenOk(),
    { status: 429, headers: { 'retry-after': '2' }, body: { error: { message: 'rate' } } },
    { status: 200, body: { ok: 1 } },
  ]);
  const slept: number[] = [];
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, maxRetryAfterMs: 10_000,
    sleep: async (ms) => { slept.push(ms); },
  });
  // The 429 arrives on the first call, which then waits and succeeds.
  assert.deepEqual(await c.api('/search'), { ok: 1 });
  assert.equal(calls.length, 3);
  assert.ok(slept.some((ms) => ms >= 2000), `waited out the window: ${slept}`);
});

test('background calls are spaced; foreground is never queued behind them', async () => {
  const script: Step[] = [tokenOk()];
  for (let i = 0; i < 4; i++) script.push({ status: 200, body: { id: `A${i}` } });
  const { fetchImpl } = fakeFetch(script);
  const slept: number[] = [];
  let now = 1_000_000;
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, backgroundGapMs: 150,
    now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; },
  });
  await c.getArtist('A0', { background: true });
  await c.getArtist('A1', { background: true });
  await c.getArtist('A2', { background: true });
  assert.ok(slept.length >= 2 && slept.every((ms) => ms <= 150), `spaced by the gap: ${slept}`);

  const before = slept.length;
  await c.getMe(); // foreground
  assert.equal(slept.length, before, 'foreground is not spaced — music must not queue behind enrichment');
});

test('missing credentials fail with a SpotifyAuthError that names the three env keys', async () => {
  const c = new SpotifyClient({ fetch: fakeFetch([]).fetchImpl, credentials: () => ({ clientId: '', clientSecret: '', refreshToken: '' }) });
  assert.equal(c.hasCredentials(), false);
  await assert.rejects(c.api('/me'), (e: any) => e instanceof SpotifyAuthError && /SPOTIFY_REFRESH_TOKEN/.test(e.message));
});

test('a rotated refresh token and every access token reach their sinks; logs carry no token', async () => {
  const rotated: string[] = [];
  const access: string[] = [];
  const logs: string[] = [];
  const { fetchImpl } = fakeFetch([
    { status: 200, body: { access_token: 'NEWACCESS_abcdefghijklmnopqrstuvwxyz0123456789', expires_in: 60, refresh_token: 'ROTATED_abcdefghijklmnopqrstuvwxyz0123456789' } },
    { status: 200, body: {} },
    { status: 500, body: { error: { message: 'boom access_token=SHOULDNOTAPPEAR_abcdefghijklmnopqrstuvwxyz' } } },
  ]);
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, log: (l) => logs.push(l),
    onRefreshToken: (t) => { rotated.push(t); },
    onAccessToken: (t) => { access.push(t); },
  });
  await c.api('/me');
  assert.deepEqual(rotated, ['ROTATED_abcdefghijklmnopqrstuvwxyz0123456789']);
  assert.deepEqual(access, ['NEWACCESS_abcdefghijklmnopqrstuvwxyz0123456789']);
  await assert.rejects(c.api('/me'));
  for (const l of logs) {
    assert.ok(!/NEWACCESS|ROTATED|SHOULDNOTAPPEAR/.test(l), `token leaked into log: ${l}`);
  }
});

test('204 and allow404 read as null; other errors throw with endpoint + status', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 204 }, { status: 404, body: {} }, { status: 502, body: { error: { message: 'bad gateway' } } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  assert.equal(await c.pause('dev'), null);
  assert.equal(await c.getTrack('x'), null);
  await assert.rejects(c.getDevices(), (e: any) => e instanceof SpotifyApiError && e.status === 502 && e.endpoint === 'GET /v1/me/player/devices');
});

test('player commands carry device_id as a query param and the body only when it has content', async () => {
  const { fetchImpl, calls } = fakeFetch([tokenOk(), { status: 204 }, { status: 204 }, { status: 204 }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  await c.play({ deviceId: 'D1', uris: ['spotify:track:abc'] });
  await c.play({ deviceId: 'D1' });
  await c.transfer('D1', true);
  const play1 = calls[1];
  assert.ok(play1.url.endsWith('/me/player/play?device_id=D1'));
  assert.deepEqual(JSON.parse(play1.init.body), { uris: ['spotify:track:abc'] });
  assert.equal(calls[2].init.body, undefined, 'resume carries no body');
  assert.deepEqual(JSON.parse(calls[3].init.body), { device_ids: ['D1'], play: true });
});

test('paginate walks `next` pages and honours `max`', async () => {
  const { fetchImpl } = fakeFetch([
    tokenOk(),
    { status: 200, body: { items: [1, 2], next: 'x' } },
    { status: 200, body: { items: [3, 4], next: 'y' } },
    { status: 200, body: { items: [5], next: null } },
  ]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  const out: number[] = [];
  for await (const n of c.paginate<number>((o) => c.api('/x', { query: { offset: o } }), { pageSize: 2 })) out.push(n);
  assert.deepEqual(out, [1, 2, 3, 4, 5]);

  const capped = fakeFetch([tokenOk(), { status: 200, body: { items: [1, 2], next: 'x' } }]);
  const c2 = new SpotifyClient({ fetch: capped.fetchImpl, credentials: creds });
  const few: number[] = [];
  for await (const n of c2.paginate<number>((o) => c2.api('/x', { query: { offset: o } }), { pageSize: 2, max: 1 })) few.push(n);
  assert.deepEqual(few, [1]);
});

test('authorizeUrl carries every scope librespot and the controller need', () => {
  const u = new URL(SpotifyClient.authorizeUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's1' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://x/cb');
  assert.equal(u.searchParams.get('state'), 's1');
  const scopes = (u.searchParams.get('scope') ?? '').split(' ');
  for (const s of SPOTIFY_SCOPES) assert.ok(scopes.includes(s), `scope ${s}`);
  assert.ok(scopes.includes('streaming'), 'librespot login needs streaming');
});

test('playlist contents come from /items, capped at 50, with no market param', async () => {
  const { fetchImpl, calls } = fakeFetch([tokenOk(), { status: 200, body: { items: [] } }, { status: 200, body: { items: [] } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  await c.getPlaylistItems('PL1');
  await c.getPlaylistItems('PL1', { limit: 100, offset: 50 });
  const u1 = new URL(calls[1].url);
  assert.equal(u1.pathname, '/v1/playlists/PL1/items', '/tracks was REMOVED and now 403s');
  assert.equal(u1.searchParams.get('limit'), '50');
  assert.equal(u1.searchParams.get('additional_types'), 'track');
  assert.equal(u1.searchParams.get('market'), null, 'from_token is gone — the user token carries the country');
  assert.equal(new URL(calls[2].url).searchParams.get('limit'), '50', 'an over-asked page is clamped, not passed through');
});

test('search never asks for more than ten, and the removed batch/top-tracks calls are gone from the client', async () => {
  const { fetchImpl, calls } = fakeFetch([tokenOk(), { status: 200, body: { tracks: { items: [] } } }, { status: 200, body: { tracks: { items: [] } } }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds });
  await c.search('portishead', ['track'], { limit: 50 });
  await c.search('portishead', ['track'], {});
  for (const i of [1, 2]) {
    const u = new URL(calls[i].url);
    assert.equal(u.searchParams.get('limit'), '10', 'Spotify caps /search at 10 — asking 50 returns a trimmed page');
    assert.equal(u.searchParams.get('market'), null);
  }
  const surface = c as unknown as Record<string, unknown>;
  for (const gone of ['getTracks', 'getArtists', 'getArtistTopTracks']) {
    assert.equal(typeof surface[gone], 'undefined', `${gone} hits an endpoint Spotify removed`);
  }
  assert.equal(typeof c.getArtist, 'function', 'the per-id read is the replacement for the batch');
});

test('a failure with no error.message still says something — the bare "Forbidden" that named nothing', async () => {
  const logs: string[] = [];
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 403, body: undefined }]);
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, log: (l) => logs.push(l) });
  await assert.rejects(c.getPlaylistItems('PL1'), (e: any) => e instanceof SpotifyApiError && e.status === 403);
  assert.match(logs.join('\n'), /playlists\/PL1\/items → 403/);

  // A non-JSON body — what a removed route actually answers — must not be
  // swallowed: the raw prefix is the only clue the operator gets.
  const logs2: string[] = [];
  const html = fakeFetch([tokenOk(), { status: 403, body: '<html>Forbidden: endpoint removed</html>' }]);
  const c2 = new SpotifyClient({ fetch: html.fetchImpl, credentials: creds, log: (l) => logs2.push(l) });
  await assert.rejects(c2.api('/playlists/PL1/items'), (e: any) => e.status === 403);
  assert.match(logs2.join('\n'), /endpoint removed/, 'the body reaches the log, not just "Forbidden"');
});

test('redactSpotify hides token-shaped values', () => {
  const s = redactSpotify('access_token=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd Bearer ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxw');
  assert.ok(!/ABCDEFGHIJKLMNOP|ZYXWVUTSRQ/.test(s), s);
});

// ── the pacer, the quota reason, and the hold that outlives a restart ───────

// The gate above is REACTIVE: it only learns about a limit by being refused by
// one. The pacer is the other half — a ceiling on non-critical request STARTS,
// so the catalogue walk (~100 back-to-back foreground requests on a 5000-track
// pool, previously unspaced) cannot earn the 429 in the first place.
test('the pacer holds background work at the ceiling; critical is never paced', async () => {
  const script: Step[] = [tokenOk()];
  for (let i = 0; i < 40; i++) script.push({ status: 200, body: { id: 'A' } });
  const { fetchImpl, calls } = fakeFetch(script);
  let now = 1_000_000;
  const waits: number[] = [];
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now,
    requestsPer30s: () => 10,
    backgroundGapMs: 0,
    // Advancing the clock inside the injected sleep is what makes the window
    // actually roll; without it the pacer would spin.
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  for (let i = 0; i < 10; i++) await c.getArtist('A' + i, { background: true });
  assert.equal(waits.length, 0, 'the first window-full goes straight through');
  assert.equal(c.pacerState().usedInWindow, 10);

  // The eleventh has to wait for the first to fall out of the rolling window.
  await c.getArtist('A10', { background: true });
  assert.equal(waits.length, 1, 'the ceiling is enforced, not merely reported');
  assert.ok(waits[0] > 0 && waits[0] <= 30_100, `a wait bounded by the window, got ${waits[0]}`);

  // Critical never queues behind any of it — the lane rule this whole file is
  // built on. A player command is what keeps music on air.
  const before = waits.length;
  await c.getPlaybackState();
  assert.equal(waits.length, before, 'a player command is not paced');
  assert.ok(calls.length > 10);
});

// A FOREGROUND call is something an operator or a track boundary is waiting on,
// and the ceiling is our guess at a limit Spotify does not publish. Holding a
// search for half a minute on a guess is worse than spending the request and
// letting the real 429 answer.
test('a foreground call waits only a short while for the pacer, then goes anyway', async () => {
  const script: Step[] = [tokenOk()];
  for (let i = 0; i < 20; i++) script.push({ status: 200, body: { ok: true } });
  const { fetchImpl, calls } = fakeFetch(script);
  let now = 1_000_000;
  const waits: number[] = [];
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now,
    requestsPer30s: () => 5, maxRetryAfterMs: 1_000,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  for (let i = 0; i < 5; i++) await c.getMe();
  const spent = calls.length;
  await c.getMe();
  assert.equal(waits.length, 0, 'the wait would exceed maxRetryAfterMs, so it is not taken');
  assert.equal(calls.length, spent + 1, 'and the request is sent rather than stalled');
});

// Spotify publishes no Development Mode number, and since 2026-07-23 the budget
// is shared with every other app on the developer account — so the ceiling has
// to find the real limit rather than assume one.
test('the ceiling halves on a 429 and eases back over clean windows', async () => {
  const { fetchImpl } = fakeFetch([
    tokenOk(),
    { status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'rate limit' } } },
    { status: 200, body: { ok: true } },
    { status: 200, body: { ok: true } },
    { status: 200, body: { ok: true } },
  ]);
  let now = 1_000_000;
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now,
    requestsPer30s: () => 100, sleep: async (ms) => { now += ms; },
  });
  assert.equal(c.pacerState().ceiling, 100);
  await c.getMe();
  assert.equal(c.pacerState().ceiling, 50, 'a refusal halves it');

  // Recovery is at most once per window, and slow — climbing fast is how the
  // halving gets undone before the real limit has been felt.
  now += 30_001;
  await c.getMe();
  assert.equal(c.pacerState().ceiling, 55);
  now += 30_001;
  await c.getMe();
  assert.equal(c.pacerState().ceiling, 61);
  assert.equal(c.pacerState().configured, 100, 'it climbs back towards the configured value, never past it');
});

// Two different refusals wearing the same status code. A rolling-window 429
// clears in seconds; an exhausted account budget clears on Spotify's schedule,
// so clamping it to the window's 30-minute bound would have the station asking
// again with hours left to run.
test('QUOTA_EXCEEDED is held longer than a rolling-window 429 and is named as itself', async () => {
  const { fetchImpl } = fakeFetch([
    tokenOk(),
    // No Retry-After: the fallback is what is being tested.
    { status: 429, body: { reason: 'QUOTA_EXCEEDED', error: { message: 'quota exceeded' } } },
  ]);
  const logs: string[] = [];
  const now = 1_000_000;
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, now: () => now, log: (l) => logs.push(l), sleep: noSleep });

  await assert.rejects(c.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  const hold = c.rateLimitHold();
  assert.equal(hold.kind, 'quota');
  assert.ok(hold.msLeft > 5_000, `an unlabelled 429 falls back to 5s; a quota one must not, got ${hold.msLeft}`);
  assert.match(logs.join('|'), /QUOTA/, 'the operator is told which refusal this is');
  assert.match(logs.join('|'), /shared by every app/, 'and that it is an account-wide budget, not a 30-second blip');
});

// A restart is exactly when the pool gets rebuilt, so a forgotten window means
// walking the whole catalogue straight back into it — and Docker restart
// policies make that a loop.
test('a hold outlives the process: it is saved on a 429 and restored by the next client', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 429, headers: { 'retry-after': '600' }, body: {} }]);
  const now = 1_000_000;
  let saved: any = null;
  const first = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep,
    saveHold: (h) => { saved = h; },
  });
  await assert.rejects(first.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  assert.ok(saved, 'the hold reached the sink');
  assert.equal(saved.until, 1_000_000 + 600_000);
  assert.equal(saved.kind, 'rate-limit');

  // A brand-new client — the restart — reads it back and asks for nothing.
  const logs: string[] = [];
  const { fetchImpl: f2, calls: c2 } = fakeFetch([tokenOk()]);
  const second = new SpotifyClient({
    fetch: f2, credentials: creds, now: () => now, sleep: noSleep, log: (l) => logs.push(l),
    loadHold: () => saved,
  });
  assert.equal(second.rateLimitedForMs(), 600_000, 'the window survived the restart');
  await assert.rejects(second.getArtist('A1', { background: true }), (e: any) => e instanceof SpotifyRateLimitError);
  assert.equal(c2.length, 0, 'not one request — this is the walk that used to renew the limit');
  assert.match(logs.join('|'), /before the restart/, 'a deliberately quiet station says so');

  // An expired hold on disk is simply not a hold.
  const third = new SpotifyClient({ fetch: f2, credentials: creds, now: () => now + 600_001, loadHold: () => saved });
  assert.equal(third.rateLimitedForMs(), 0);
});

// ── the lockout: a hold must be a DEADLINE, not a sliding window ────────────

// THE REGRESSION TEST FOR THE WHOLE INCIDENT.
//
// The hold used to be recomputed as `now + Retry-After` on every 429 and kept
// whenever it was later than the current one — which, with a constant header,
// is always, because the clock has moved on. Every refusal slid the wall a full
// window further out. And the `critical` lane bypasses the gate so music keeps
// playing, so a track every few minutes kept re-arming a 3706-second hold about
// every hundred seconds. The station sat locked out for a full day, restarts
// included, because the slid deadline was also written to disk each time.
test('a player 429 every minute cannot hold the gate open — it counts down and clears', async () => {
  const script: Step[] = [tokenOk(), { status: 429, headers: { 'retry-after': '600' }, body: {} }];
  // Then a player command 429ing over and over, exactly as an exhausted account
  // answers every request.
  for (let i = 0; i < 60; i++) script.push({ status: 429, headers: { 'retry-after': '600' }, body: {} });
  const { fetchImpl } = fakeFetch(script);
  let now = 1_000_000;
  const saved: any[] = [];
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep,
    saveHold: (h) => saved.push(h),
  });

  // A gated lane asks, is refused, and opens the episode.
  await assert.rejects(c.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  const openedAt = now;
  assert.equal(c.rateLimitedForMs(), 600_000);

  // Now the player keeps working, and keeps being refused, for the whole window.
  for (let i = 0; i < 59; i++) {
    now += 10_000;
    await c.play({ uris: ['spotify:track:x'] }).catch(() => {});
    assert.equal(
      c.rateLimitedForMs(),
      Math.max(0, openedAt + 600_000 - now),
      `the deadline must not move (minute ${i})`,
    );
  }

  // …and it is gone on schedule rather than a day later.
  assert.equal(c.rateLimitedForMs(), 10_000);
  now += 10_001;
  assert.equal(c.rateLimitedForMs(), 0, 'the hold cleared itself — this is what could not happen');
  assert.equal(saved.length, 1, 'and it was written to disk ONCE, not re-armed on every refusal');
});

test('a critical refusal never arms a gate that is open, and never moves the pacer', async () => {
  const { fetchImpl, calls } = fakeFetch([
    tokenOk(),
    { status: 429, headers: { 'retry-after': '600' }, body: { reason: 'QUOTA_EXCEEDED' } },
    { status: 200, body: { ok: true } },
  ]);
  let now = 1_000_000;
  let saved = 0;
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep,
    requestsPer30s: () => 100, saveHold: () => { saved++; },
  });

  await c.play({ uris: ['spotify:track:x'] }).catch(() => {});
  assert.equal(c.rateLimitedForMs(), 0, 'a player refusal does not stop catalogue work');
  assert.equal(saved, 0, 'and nothing is persisted for it');
  assert.equal(c.pacerState().ceiling, 100, 'the pacer cannot slow the critical lane, so it must not be halved by it');
  assert.equal(calls.length, 2, 'and it is not retried — the transport owns that backoff, and retrying doubles the rate during the outage');

  // The catalogue lane still works, which is the whole point.
  assert.deepEqual(await c.getMe(), { ok: true });
  const spent = calls.length;
  assert.ok(spent >= 3);
});

test('the kind downgrades — a quota hold does not brand every later window', async () => {
  const { fetchImpl } = fakeFetch([
    tokenOk(),
    { status: 429, headers: { 'retry-after': '600' }, body: { reason: 'QUOTA_EXCEEDED' } },
    { status: 429, headers: { 'retry-after': '5' }, body: {} },
  ]);
  let now = 1_000_000;
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep });

  await assert.rejects(c.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  assert.equal(c.rateLimitHold().kind, 'quota');

  // The window passes; the next refusal is an ordinary rolling-window one.
  now += 600_001;
  await assert.rejects(c.getArtist('A2', { background: true }), (e: any) => e.status === 429);
  assert.equal(c.rateLimitHold().kind, 'rate-limit', 'once quota, always quota was carrying a 6-hour cap into a 5-second window');
  assert.equal(c.rateLimitedForMs(), 5_000);
});

test('an operator press reaches the network while the gate is shut', async () => {
  const { fetchImpl, calls } = fakeFetch([
    tokenOk(),
    { status: 429, headers: { 'retry-after': '3706' }, body: { reason: 'QUOTA_EXCEEDED' } },
    { status: 200, body: { display_name: 'the operator' } },
  ]);
  const now = 1_000_000;
  const c = new SpotifyClient({ fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep });

  await assert.rejects(c.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  const spent = calls.length;

  // An ordinary catalogue read is refused without a request, as it should be…
  await assert.rejects(c.getMe(), (e: any) => e instanceof SpotifyRateLimitError);
  assert.equal(calls.length, spent);
  // …and the error names the refusal correctly rather than calling an exhausted
  // account budget a "rate limit" the operator should wait thirty seconds for.
  await c.getMe().catch((e: any) => {
    assert.equal(e.kind, 'quota');
    assert.match(e.message, /quota exhausted/);
  });

  // But the button they just pressed answers.
  const me: any = await c.getMe({ operator: true });
  assert.equal(me.display_name, 'the operator');
  assert.ok(calls.length > spent, 'the operator lane reached the network');
});

test('clearHold forgets the hold in memory and on disk', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 429, headers: { 'retry-after': '600' }, body: {} }]);
  const now = 1_000_000;
  let cleared = 0;
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep,
    clearHold: () => { cleared++; },
  });
  await assert.rejects(c.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  assert.equal(c.rateLimitedForMs(), 600_000);
  c.clearHold();
  assert.equal(c.rateLimitedForMs(), 0);
  assert.equal(cleared, 1, 'the persisted hold goes too, or the next restart restores it');
});

test('an implausible saved hold is not honoured across a restart', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 200, body: { ok: true } }]);
  const now = 1_000_000;
  let cleared = 0;
  const logs: string[] = [];
  // A six-hour deadline is what the sliding-hold bug wrote. A station that boots
  // into one can never recover on its own, so it is treated as the corruption
  // it is: ask once and find out where we really stand.
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep, log: (l) => logs.push(l),
    loadHold: () => ({ until: now + 6 * 60 * 60_000, kind: 'quota', at: now }),
    clearHold: () => { cleared++; },
  });
  assert.equal(c.rateLimitedForMs(), 0, 'not honoured');
  assert.equal(cleared, 1);
  assert.match(logs.join('|'), /ignoring a saved hold/);
  assert.deepEqual(await c.getMe(), { ok: true }, 'and the station asks');
});

// The pacer used to recover only when a non-critical request was made — and
// during a hold, by definition, none is. So it sat at its floor of 10 and then
// climbed +1 per window, needing ~80 requests to get back to 90: throttled by
// exactly the traffic the throttle was suppressing.
test('the ceiling recovers on the clock, not on traffic', async () => {
  const { fetchImpl } = fakeFetch([
    tokenOk(),
    { status: 429, headers: { 'retry-after': '600' }, body: {} },
  ]);
  let now = 1_000_000;
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep,
    requestsPer30s: () => 90,
  });
  await assert.rejects(c.getArtist('A1', { background: true }), (e: any) => e.status === 429);
  assert.equal(c.pacerState().ceiling, 45);

  // A quiet hour passes with no requests at all — which is exactly what a hold
  // looks like from in here.
  now += 60 * 60_000;
  assert.equal(c.pacerState().ceiling, 90, 'fully recovered without a single request to drive it');
});

test('lowering the configured ceiling applies at once', async () => {
  const { fetchImpl } = fakeFetch([tokenOk(), { status: 200, body: { ok: true } }]);
  const now = 1_000_000;
  let configured = 90;
  const c = new SpotifyClient({
    fetch: fetchImpl, credentials: creds, now: () => now, sleep: noSleep,
    requestsPer30s: () => configured,
  });
  await c.getMe();
  assert.equal(c.pacerState().ceiling, 90);
  configured = 20;
  assert.equal(c.pacerState().ceiling, 20, 'an operator turning it down is not something to climb down to');
});
