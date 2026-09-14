// The MCP half of GET /similar-tracks (#1575) — SubwaveClient.similarTracks
// and the credential it rides on.
//
// This is the one piece of the feature no other test reaches. The route tests
// drive Express directly and the catalog drift guard only checks that the tool
// is REGISTERED; neither exercises what the client sends or what an agent is
// told when the call is refused. Two claims are load-bearing and both are
// easy to break silently:
//
//  - THE STATION PASSWORD RIDES ITS OWN HEADER. It is a different secret from
//    the admin one, so it must never travel as Authorization (where the admin
//    credential lives) and must be absent entirely on a public station.
//  - A 401 NAMES THE STATION SECRET. An agent told "the controller rejected
//    admin credentials" for a station-gated call goes looking for a credential
//    that would not help it — the generic admin branch is directly below the
//    station one in call(), so a reordering turns this into a dead end with no
//    other test noticing.
//
// fetch is stubbed; no controller needed.

import test from 'node:test';
import assert from 'node:assert/strict';

const { SubwaveClient, SubwaveError } = await import('../src/mcp/client.js');

interface Seen { url: string; headers: Record<string, string> }

function stubFetch(status: number, body: unknown): { seen: Seen[]; restore: () => void } {
  const seen: Seen[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { headers?: Record<string, string> } = {}) => {
    seen.push({ url: String(url), headers: { ...(init.headers || {}) } });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as never;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const OK_BODY = { seed: { id: 't1', title: 'A', artist: 'B' }, results: [], reason: 'ok', message: null };

// --- where the credential rides -------------------------------------------

test('the station password travels as x-station-auth, never as Authorization', async () => {
  const f = stubFetch(200, OK_BODY);
  try {
    const c = new SubwaveClient({
      baseUrl: 'http://ctl',
      adminUser: 'admin',
      adminPass: 'adminpw',
      stationPassword: 'stationpw',
    });
    await c.similarTracks({ id: 't1' });

    const [call] = f.seen;
    assert.equal(call.headers['x-station-auth'], 'stationpw');
    // The admin credential must NOT be attached: this endpoint is not admin
    // gated, and sending Basic here is how an admin password leaks to a
    // surface that never needed it.
    assert.equal(call.headers.authorization, undefined, 'no Authorization on a station-gated read');
  } finally { f.restore(); }
});

test('a public station sends no credential at all', async () => {
  const f = stubFetch(200, OK_BODY);
  try {
    await new SubwaveClient({ baseUrl: 'http://ctl' }).similarTracks({ id: 't1' });
    assert.equal('x-station-auth' in f.seen[0].headers, false, 'nothing to send, so nothing sent');
  } finally { f.restore(); }
});

test('a forwarded header beats a configured password', async () => {
  // routes/mcp.ts passes the CALLER's x-station-auth through; the stdio
  // server's SUBWAVE_STATION_PASSWORD is the fallback for its own process.
  const f = stubFetch(200, OK_BODY);
  try {
    await new SubwaveClient({
      baseUrl: 'http://ctl',
      stationPassword: 'from-env',
      forwardStationAuth: 'from-caller',
    }).similarTracks({ id: 't1' });
    assert.equal(f.seen[0].headers['x-station-auth'], 'from-caller');
  } finally { f.restore(); }
});

test('id, q and limit reach the query string; absent params are omitted', async () => {
  const f = stubFetch(200, OK_BODY);
  try {
    const c = new SubwaveClient({ baseUrl: 'http://ctl' });
    await c.similarTracks({ id: 'abc', limit: 5 });
    assert.match(f.seen[0].url, /\/similar-tracks\?/);
    assert.match(f.seen[0].url, /id=abc/);
    assert.match(f.seen[0].url, /limit=5/);
    assert.equal(/[?&]q=/.test(f.seen[0].url), false, 'an absent q is not sent as empty');

    await c.similarTracks({ q: 'boards of canada' });
    assert.match(f.seen[1].url, /q=boards\+of\+canada|q=boards%20of%20canada/);
  } finally { f.restore(); }
});

// --- what an agent is told when it is refused ------------------------------

test('a 401 names the STATION secret, never the admin one', async () => {
  const f = stubFetch(401, { error: 'station password required' });
  try {
    const c = new SubwaveClient({ baseUrl: 'http://ctl', adminUser: 'admin', adminPass: 'pw' });
    const err = await c.similarTracks({ id: 't1' }).then(() => null, (e: Error) => e);

    assert.ok(err instanceof SubwaveError, 'refusals arrive as SubwaveError');
    const msg = String(err?.message);
    assert.match(msg, /station/i, 'the message names the station password');
    // The generic admin branch sits directly below this one in call(). If the
    // station check is reordered or dropped, the agent is sent after a
    // credential it may already hold and that would not help.
    assert.equal(/admin credential/i.test(msg), false, 'must not send the agent after admin creds');
    assert.match(msg, /SUBWAVE_STATION_PASSWORD|x-station-auth/, 'it says how to supply the right one');
  } finally { f.restore(); }
});

test('a 401 WITH a station password says the password is wrong, not missing', async () => {
  const f = stubFetch(401, { error: 'nope' });
  try {
    const c = new SubwaveClient({ baseUrl: 'http://ctl', stationPassword: 'wrong' });
    const err = await c.similarTracks({ id: 't1' }).then(() => null, (e: Error) => e);
    assert.match(String(err?.message), /doesn't match|does not match/i);
  } finally { f.restore(); }
});

test('an ADMIN endpoint still reports admin credentials on 401', async () => {
  // The station branch is conditional on init.station — it must not swallow
  // the admin message for the /dj/* surface.
  const f = stubFetch(401, { error: 'nope' });
  try {
    const c = new SubwaveClient({ baseUrl: 'http://ctl' });
    const err = await c.skipTrack().then(() => null, (e: Error) => e);
    assert.match(String(err?.message), /admin/i);
    assert.equal(/x-station-auth/.test(String(err?.message)), false);
  } finally { f.restore(); }
});
