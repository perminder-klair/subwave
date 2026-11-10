// POST /request against the daily token budget and the queue-depth cap,
// driven through a real Express app so the route's own gates are what run.
//
// 1. At the hard cap with llm.exemptRequests off (dj-budget.requestsAllowed()
//    false), a listener request still resolves — but with NO model call: no
//    matcher, no intro. Gate before generation, never at the dispatcher.
// 2. requests.maxPending counts requests still RESOLVING, not only the ones
//    already in the upcoming queue — those hold no queue slot until their
//    resolution pushes, so a burst inside one window used to all pass.
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-request-budget-'));

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/request.js');
const { recentCalls } = await import('../src/llm/log.js');
const { addDailyUsage } = await import('../src/llm/internal/telemetry/budget.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { queue } = await import('../src/broadcast/queue.js');
const { invalidateWeatherCache } = await import('../src/context.js');

await settings.load();

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const realFetch = globalThis.fetch;
const SONG = { id: 'song-1', title: 'Budget Song', artist: 'Cap Artist', album: 'Ledger', duration: 200, isDir: false };

// Everything off-box is stubbed: Subsonic answers search3 with one song,
// anything else (Icecast status, Open-Meteo, a model) fails fast unless the
// test hands in its own handler.
function stubNetwork(t: TestContext, other: (url: string) => Promise<Response> = async () => { throw new Error('offline'); }) {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(base)) return realFetch(input, init);
    if (url.includes('/rest/search3')) {
      return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', searchResult3: { song: [SONG] } } }));
    }
    return other(url);
  });
}

function countModelCalls(t: TestContext) {
  let n = 0;
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) {
    t.mock.method(model, 'doGenerate', async () => { n++; throw new Error('no model in this test'); });
  }
  return () => n;
}

async function post(text: string, ip: string) {
  const res = await realFetch(`${base}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ text, name: 'Tester' }),
  });
  return { status: res.status, body: await res.json() as any };
}

async function settle(id: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await (await realFetch(`${base}/request/${id}`)).json() as any;
    if (r.status !== 'pending') return r;
    if (Date.now() > deadline) throw new Error(`request ${id} never settled`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('at the hard cap with requests not exempt, a request resolves without a model call', async (t) => {
  await settings.update({
    llm: { dailyTokenCap: 1000, exemptRequests: false },
    requests: { enabled: true, maxPending: 6, onePendingPerIp: false },
  } as never);
  addDailyUsage(5000);
  invalidateWeatherCache();
  stubNetwork(t);
  const modelCalls = countModelCalls(t);
  recentCalls.length = 0;

  const accepted = await post('Budget Song', '198.51.100.1');
  assert.equal(accepted.status, 202);
  const outcome = await settle(accepted.body.requestId);

  assert.equal(outcome.status, 'resolved', `resolved without the model (${outcome.message ?? ''})`);
  assert.equal(outcome.track?.title, SONG.title, 'the library search found the named song');
  assert.equal(modelCalls(), 0, 'no provider call');
  assert.equal(recentCalls.length, 0, 'no LLM call reached the record');
  queue.upcoming.length = 0;
});

test('maxPending counts requests that are still resolving', async (t) => {
  await settings.update({ requests: { enabled: true, maxPending: 2, onePendingPerIp: false } } as never);
  invalidateWeatherCache();
  // Hold every resolution at its first step (the weather fetch inside
  // getFullContext) so all accepted requests are still resolving.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  stubNetwork(t, async (url) => {
    if (url.includes('open-meteo')) { await held; throw new Error('offline'); }
    throw new Error('offline');
  });
  countModelCalls(t);
  queue.upcoming.length = 0;

  const first = await post('Budget Song', '198.51.100.11');
  const second = await post('Budget Song', '198.51.100.12');
  const third = await post('Budget Song', '198.51.100.13');
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(third.status, 429, 'a third request is refused while two are still resolving');
  assert.match(third.body.message, /queue's full/);

  release();
  await settle(first.body.requestId);
  await settle(second.body.requestId);
  queue.upcoming.length = 0;
});
