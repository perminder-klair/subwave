// Editing a saved Station login (#1873): which health answers mean the
// station refused the login, and the check that decides whether an edited
// login is saved, refused, or saved only on "Save anyway".

import assert from 'node:assert/strict';
import test from 'node:test';
import type { HealthResult } from '../src/lib/api.ts';
import type { StationCredentials } from '../src/lib/station-credentials.ts';
import { checkStationLogin, loginRefused, saveAnywayOffered } from '../src/lib/station-login.ts';
import type { StationAuthResult } from '../src/lib/station-password.ts';

test('only a 401 with a login challenge is a refused login', () => {
  assert.equal(loginRefused({ ok: false, kind: 'http', status: 401, challenged: true }), true);
  const silent: HealthResult[] = [
    { ok: true },
    { ok: false, kind: 'timeout' },
    { ok: false, kind: 'network', message: 'Network request failed' },
    // No challenge: not a proxy asking for a login.
    { ok: false, kind: 'http', status: 401 },
    { ok: false, kind: 'http', status: 401, challenged: false },
    // An IP allowlist, a WAF or a Cloudflare challenge page: no login fixes it.
    { ok: false, kind: 'http', status: 403 },
    { ok: false, kind: 'http', status: 403, challenged: true },
    // A proxy on the listener's own network, not the station.
    { ok: false, kind: 'http', status: 407 },
    { ok: false, kind: 'http', status: 407, challenged: true },
    { ok: false, kind: 'http', status: 404 },
    { ok: false, kind: 'http', status: 500 },
    { ok: false, kind: 'http', status: 502 },
    { ok: false, kind: 'http' },
  ];
  for (const result of silent) assert.equal(loginRefused(result), false, JSON.stringify(result));
});

/** A station as the check sees it. `proxy` is the login a reverse proxy in
 *  front of /api demands; `streamPassword` is SUB/WAVE's own stream lock. */
function station(opts: {
  proxy?: StationCredentials;
  streamPassword?: string;
  health?: HealthResult;
  state?: 'unreadable';
  stationAuth?: StationAuthResult;
}) {
  const asked: string[] = [];
  const sameLogin = (a: StationCredentials | null, b: StationCredentials) =>
    !!a && a.username === b.username && a.password === b.password;
  return {
    asked,
    health: async (login: StationCredentials | null): Promise<HealthResult> => {
      asked.push(login ? `health ${login.username}` : 'health anonymous');
      if (opts.health) return opts.health;
      if (opts.proxy && !sameLogin(login, opts.proxy)) {
        return { ok: false, kind: 'http', status: 401, challenged: true };
      }
      return { ok: true };
    },
    streamPassword: async () => {
      asked.push('state');
      return opts.state === 'unreadable' ? null : opts.streamPassword !== undefined;
    },
    checkStationAuth: async (password: string): Promise<StationAuthResult> => {
      asked.push(`station-auth ${password}`);
      if (opts.stationAuth) return opts.stationAuth;
      return password === opts.streamPassword ? 'ok' : 'denied';
    },
  };
}

const login = (username: string, password: string): StationCredentials => ({ username, password });

test('a login the proxy refuses is rejected, and nothing else is asked', async () => {
  const s = station({ proxy: login('dj', 'right'), streamPassword: 'right' });
  assert.deepEqual(await checkStationLogin({ login: login('dj', 'typo'), ...s }), {
    verdict: 'rejected',
    by: 'proxy',
  });
  assert.deepEqual(s.asked, ['health dj'], 'a refused login never reaches /station-auth');
});

test('a 403 or an unchallenged 401 leaves the login unchecked, never refused', async () => {
  const answers: HealthResult[] = [
    { ok: false, kind: 'http', status: 403 },
    { ok: false, kind: 'http', status: 401 },
  ];
  for (const health of answers) {
    const s = station({ health, streamPassword: 'pw' });
    assert.deepEqual(
      await checkStationLogin({ login: login('dj', 'pw'), ...s }),
      { verdict: 'unreachable', rateLimited: false },
      JSON.stringify(health),
    );
    assert.deepEqual(s.asked, ['health dj']);
  }
});

test('a login the proxy takes is accepted when the stream password is off', async () => {
  const s = station({ proxy: login('dj', 'right') });
  assert.deepEqual(await checkStationLogin({ login: login('dj', 'right'), ...s }), { verdict: 'accepted' });
  assert.deepEqual(s.asked, ['health dj', 'state']);
});

test('a proxy login is accepted on a stream-password station even though it is not the station password', async () => {
  const s = station({ proxy: login('dj', 'proxy-pw'), streamPassword: 'station-pw' });
  assert.deepEqual(await checkStationLogin({ login: login('dj', 'proxy-pw'), ...s }), { verdict: 'accepted' });
  assert.deepEqual(s.asked, ['health dj', 'state', 'station-auth proxy-pw', 'health anonymous']);
});

test('a proxy login that is also the station password is accepted without the anonymous check', async () => {
  const s = station({ proxy: login('dj', 'shared'), streamPassword: 'shared' });
  assert.deepEqual(await checkStationLogin({ login: login('dj', 'shared'), ...s }), { verdict: 'accepted' });
  assert.deepEqual(s.asked, ['health dj', 'state', 'station-auth shared']);
});

test('with no proxy, the stream password is what checks the login', async () => {
  const right = station({ streamPassword: 'stream-pw' });
  assert.deepEqual(
    await checkStationLogin({ login: login('listener', 'stream-pw'), ...right }),
    { verdict: 'accepted' },
  );

  // The reporter's case: a wrong password typed under Station login.
  const wrong = station({ streamPassword: 'stream-pw' });
  assert.deepEqual(await checkStationLogin({ login: login('listener', 'old-pw'), ...wrong }), {
    verdict: 'rejected',
    by: 'stream-password',
  });
  assert.deepEqual(wrong.asked, ['health listener', 'state', 'station-auth old-pw', 'health anonymous']);
});

test('a station with no proxy and no stream password has nothing to refuse the login', async () => {
  const s = station({});
  assert.deepEqual(await checkStationLogin({ login: login('dj', 'anything'), ...s }), { verdict: 'accepted' });
  assert.deepEqual(s.asked, ['health dj', 'state'], 'and /station-auth is not spent');
});

test('a station that cannot be reached is never a rejection', async () => {
  const unanswered: HealthResult[] = [
    { ok: false, kind: 'timeout' },
    { ok: false, kind: 'network', message: 'Network request failed' },
    { ok: false, kind: 'http', status: 502 },
    { ok: false, kind: 'http', status: 407 },
  ];
  for (const health of unanswered) {
    const s = station({ health, streamPassword: 'pw' });
    assert.deepEqual(
      await checkStationLogin({ login: login('dj', 'pw'), ...s }),
      { verdict: 'unreachable', rateLimited: false },
      JSON.stringify(health),
    );
    assert.deepEqual(s.asked, ['health dj']);
  }
});

test('an unreadable /state cannot say whether the stream password reads the login', async () => {
  const s = station({ state: 'unreadable' });
  assert.deepEqual(await checkStationLogin({ login: login('dj', 'pw'), ...s }), {
    verdict: 'unreachable',
    rateLimited: false,
  });
});

test('a rate-limited or unavailable /station-auth leaves the login unchecked', async () => {
  const limited = station({ streamPassword: 'pw', stationAuth: 'rate-limited' });
  assert.deepEqual(await checkStationLogin({ login: login('dj', 'pw'), ...limited }), {
    verdict: 'unreachable',
    rateLimited: true,
  });
  const down = station({ streamPassword: 'pw', stationAuth: 'unavailable' });
  assert.deepEqual(await checkStationLogin({ login: login('dj', 'pw'), ...down }), {
    verdict: 'unreachable',
    rateLimited: false,
  });
  assert.deepEqual(down.asked, ['health dj', 'state', 'station-auth pw'], 'no anonymous check behind it');
});

test('a denied password with no anonymous answer cannot tell a proxy from none', async () => {
  const anonymous: HealthResult[] = [
    { ok: false, kind: 'timeout' },
    // Not a login challenge, so not a proxy that took the login.
    { ok: false, kind: 'http', status: 403 },
    { ok: false, kind: 'http', status: 401 },
  ];
  for (const answer of anonymous) {
    const s = station({ streamPassword: 'station-pw' });
    const health = async (l: StationCredentials | null): Promise<HealthResult> =>
      l ? s.health(l) : answer;
    assert.deepEqual(
      await checkStationLogin({ login: login('dj', 'other'), ...s, health }),
      { verdict: 'unreachable', rateLimited: false },
      JSON.stringify(answer),
    );
  }
});

test('Save anyway is offered for any verdict but a proxy refusal', () => {
  assert.equal(saveAnywayOffered({ verdict: 'accepted' }), false);
  // The proxy reads this very login, and it said no.
  assert.equal(saveAnywayOffered({ verdict: 'rejected', by: 'proxy' }), false);
  // A proxy that guards only the stream may still want it, unseen.
  assert.equal(saveAnywayOffered({ verdict: 'rejected', by: 'stream-password' }), true);
  assert.equal(saveAnywayOffered({ verdict: 'unreachable', rateLimited: false }), true);
  assert.equal(saveAnywayOffered({ verdict: 'unreachable', rateLimited: true }), true);
});
