// Open-Meteo is one upstream metered per source IP, shared by the station's own
// forecast (getWeather, reached from the public /now-playing poll through
// getFullContext) and the location picker's GET /geocode.
//
// 1. A failed forecast fetch is remembered for a backoff window: polls inside
//    it make no request, keep the last good reading, and concurrent callers on
//    an expired cache share one fetch.
// 2. GET /geocode is admin-only (its two callers, the admin Station tab and
//    onboarding, run signed in) and refuses an over-long query unforwarded.
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-weather-geocode-'));
process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { getWeather, invalidateWeatherCache } = await import('../src/context.js');
const { router } = await import('../src/routes/public.js');

await settings.load();

const realFetch = globalThis.fetch;
const forecast = (temp: number) => new Response(JSON.stringify({
  current: { temperature_2m: temp, weather_code: 0, is_day: 1 },
}));

function stubForecast(t: TestContext, answer: () => Promise<Response>) {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    if (url.includes('geocoding-api.open-meteo.com')) {
      n++;
      return new Response(JSON.stringify({ results: [{ name: 'Leeds', country: 'UK', latitude: 53.8, longitude: -1.55 }] }));
    }
    if (url.includes('api.open-meteo.com')) { n++; return answer(); }
    throw new Error(`unexpected fetch ${url}`);
  });
  return () => n;
}

test('a failed forecast is not re-fetched on every poll, and the last good reading holds', async (t) => {
  invalidateWeatherCache();
  let upstream: 'up' | 'down' = 'up';
  const fetches = stubForecast(t, async () => (upstream === 'up' ? forecast(12) : new Response('rate limited', { status: 429 })));
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);

  const good = await getWeather();
  assert.equal(good.temp, 12);
  assert.equal(fetches(), 1);

  // Past the 30-minute TTL with the upstream refusing.
  upstream = 'down';
  clock.mock.mockImplementation(() => now + 31 * 60_000);
  const stale = await getWeather();
  assert.equal(stale.temp, 12, 'a failure keeps the last good reading rather than flapping to unknown');
  assert.equal(fetches(), 2);

  // Many polls inside the backoff: no further upstream traffic.
  for (let i = 0; i < 20; i++) await getWeather();
  assert.equal(fetches(), 2, 'polls inside the failure backoff make no request');

  // After the backoff the station tries again, and recovers.
  upstream = 'up';
  clock.mock.mockImplementation(() => now + 37 * 60_000);
  assert.equal((await getWeather()).temp, 12);
  assert.equal(fetches(), 3);
});

test('with no reading yet, a failure answers unknown and still backs off', async (t) => {
  invalidateWeatherCache();
  const fetches = stubForecast(t, async () => { throw new Error('ETIMEDOUT'); });
  assert.equal((await getWeather()).condition, 'unknown');
  assert.equal((await getWeather()).condition, 'unknown');
  assert.equal(fetches(), 1);
});

test('concurrent polls on an expired cache share one fetch', async (t) => {
  invalidateWeatherCache();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fetches = stubForecast(t, async () => { await held; return forecast(8); });
  const polls = Array.from({ length: 10 }, () => getWeather());
  release();
  const results = await Promise.all(polls);
  assert.equal(fetches(), 1);
  assert.ok(results.every((r) => r.temp === 8));
});

test('GET /geocode needs the admin credential and bounds the query', async (t) => {
  const app = express();
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetches = stubForecast(t, async () => forecast(1));
  const auth = { authorization: `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}` };

  const anon = await realFetch(`${base}/geocode?q=Leeds`);
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get('www-authenticate'), null, 'no native Basic dialog for the web picker');
  assert.equal(fetches(), 0, 'an anonymous query is never forwarded');

  const long = await realFetch(`${base}/geocode?q=${'x'.repeat(101)}`, { headers: auth });
  assert.equal(long.status, 400);
  assert.equal(fetches(), 0, 'an over-long query is never forwarded');

  const ok = await realFetch(`${base}/geocode?q=Leeds`, { headers: auth });
  assert.equal(ok.status, 200);
  const body = await ok.json() as { results: Array<{ name: string }> };
  assert.equal(body.results[0]?.name, 'Leeds');
  assert.equal(fetches(), 1);
});
