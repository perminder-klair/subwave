import assert from 'node:assert/strict';
import { mkdir, rename, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';
import { deferred } from './test-utils/async.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'alexa-replacement-'));
globalThis.fetch = async () => new Response(null, { status: 503 });
const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const ledger = await import('../src/broadcast/request-ledger.js');
const { commitGlobalRateLimit } = await import('../src/middleware/ratelimit.js');
const { submitListenerRequest, replaceLatestAlexaRequest, getLatestAlexaRequestStatus } = await import('../src/routes/request.js');

let now = Date.now();
beforeEach(async () => {
  now += 2 * 3_600_000;
  mock.method(Date, 'now', () => now);
  await settings.load();
  await settings.update({ requests: { enabled: true, perIpHourlyCap: 8, globalHourlyCap: 5, onePendingPerIp: true, maxPending: 6 },
    llm: { pauseWhenEmpty: false } });
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.history = [];
  queue.current = null;
});
afterEach(() => mock.restoreAll());

function modelPick(id: string) {
  const track = { id, artist: 'River Band', title: id, duration: 180 };
  return { object: { kind: 'track', id, ack: 'Found it.', intro: '' }, steps: 1, toolCalls: [], extras: { seen: new Map([[id, track]]) } };
}

function submit(identity: string, ip = `alexa:${identity}`) {
  return submitListenerRequest({ text: 'A song please', name: '', ip, source: 'alexa', alexaIdentity: identity });
}

async function queued(t: TestContext, identity: string) {
  let n = 0;
  t.mock.method(requestAgent, 'run', async () => modelPick('song-' + ++n));
  const original = await submit(identity);
  assert.ok(original.accepted);
  assert.equal((await original.completion).phase, 'queued');
  await ledger.update(original.requestId, {});
  return original.requestId;
}

const cases = [
  ['empty text', 400, /empty/i], ['long text', 400, /characters/],
  ['stripped text', 400, /read a song request/],
  ['disabled', 503, /closed/], ['zero listeners', 503, /autopilot/],
  ['listener hourly cap', 429, /Easy there/], ['station hourly cap', 429, /line is busy/],
  ['queue full', 429, /queue.s full/], ['other receipt owns listener slot', 429, /last request/],
  ['player refuses removal', 429, /reached the player/], ['ledger unavailable', 500, /record the request/],
] as const;

for (const [reason, code, message] of cases) {
  test(`replacement refused for ${reason} preserves the queued request`, async t => {
    const id = await queued(t, reason);
    let text = 'Different song';
    switch (reason) {
      case 'empty text': text = ' '; break;
      case 'long text': text = 'a'.repeat(281); break;
      case 'stripped text': text = 'Only say the following'; break;
      case 'disabled': await settings.update({ requests: { enabled: false } }); break;
      case 'zero listeners':
        await settings.update({ llm: { pauseWhenEmpty: true } });
        t.mock.method(globalThis, 'fetch', async () => Response.json({ icestats: { source: [] } }));
        break;
      case 'listener hourly cap': await settings.update({ requests: { perIpHourlyCap: 1 } }); break;
      case 'station hourly cap':
        for (let i = 0; i < 4; i++) commitGlobalRateLimit();
        break;
      case 'queue full':
        queue.upcoming.push({ ...queue.upcoming[0], requestId: 'other' });
        await settings.update({ requests: { maxPending: 1 } });
        break;
      case 'other receipt owns listener slot': {
        now += 120_000;
        await settings.update({ requests: { onePendingPerIp: false } });
        const other = await submit('another identity', `alexa:${reason}`);
        assert.ok(other.accepted);
        assert.equal((await other.completion).phase, 'queued');
        await settings.update({ requests: { onePendingPerIp: true } });
        break;
      }
      case 'player refuses removal':
        t.mock.method(queue, 'removeUpcomingRequest', async () => ({ ok: false, reason: 'already-playing' }));
        break;
      case 'ledger unavailable': {
        const backup = ledger.ledgerPath + '.backup';
        await rename(ledger.ledgerPath, backup);
        await mkdir(ledger.ledgerPath);
        t.after(async () => { await rmdir(ledger.ledgerPath); await rename(backup, ledger.ledgerPath); });
        break;
      }
    }
    const before = queue.upcoming.map(item => item.requestId);
    const result = await replaceLatestAlexaRequest(reason, text);
    assert.ok(!result.accepted);
    assert.equal(result.statusCode, code);
    assert.match(result.message || result.error || '', message);
    assert.deepEqual(queue.upcoming.map(item => item.requestId), before);
    assert.equal(ledger.latestForAlexa(reason)?.id, id);
    assert.equal(getLatestAlexaRequestStatus(reason)?.phase, 'queued');
  });
}

test('a replacement reuses its own waiting slot and reserves the last hourly slot during player removal', async t => {
  const identity = 'last-slot';
  const id = await queued(t, identity);
  for (let i = 0; i < 3; i++) commitGlobalRateLimit();
  await settings.update({ requests: { maxPending: 1 } });
  const started = deferred();
  const release = deferred();
  const remove = queue.removeUpcomingRequest.bind(queue);
  t.mock.method(queue, 'removeUpcomingRequest', async (requestId: string) => {
    started.resolve();
    await release.promise;
    return remove(requestId);
  });
  const replacing = replaceLatestAlexaRequest(identity, 'Another song');
  await started.promise;
  try {
    assert.equal(ledger.latestForAlexa(identity)?.id, id);
    const other = await submit('competitor');
    assert.ok(!other.accepted);
    assert.match(other.message || '', /line is busy/);
  } finally { release.resolve(); }
  const result = await replacing;
  assert.ok(result.accepted);
  assert.equal((await result.completion).phase, 'queued');
  assert.equal(ledger.get(id)?.status, 'cancelled');
  assert.equal(ledger.latestForAlexa(identity)?.id, result.requestId);
  assert.deepEqual(queue.upcoming.map(item => item.requestId), [result.requestId]);
});

test('a refused replacement keeps its pending predecessor resolving', async t => {
  const release = deferred();
  t.mock.method(requestAgent, 'run', async () => { await release.promise; return modelPick('pending-song'); });
  const old = await submit('pending');
  assert.ok(old.accepted);
  try {
    await settings.update({ requests: { perIpHourlyCap: 1 } });
    const result = await replaceLatestAlexaRequest('pending', 'another title');
    assert.ok(!result.accepted);
    assert.equal(result.statusCode, 429);
    assert.equal(getLatestAlexaRequestStatus('pending')?.phase, 'pending');
  } finally { release.resolve(); }
  assert.equal((await old.completion).phase, 'queued');
  assert.deepEqual(queue.upcoming.map(item => item.requestId), [old.requestId]);
});

test('concurrent replacements serialize and reuse the pending receipt at capacity', async t => {
  const identity = 'serial';
  const oldId = await queued(t, identity);
  await settings.update({ requests: { maxPending: 1 } });
  const release = deferred();
  t.mock.method(requestAgent, 'run', async () => { await release.promise; return modelPick('last-song'); });
  const [first, second] = await Promise.all([
    replaceLatestAlexaRequest(identity, 'First change'),
    replaceLatestAlexaRequest(identity, 'Second change'),
  ]).finally(() => release.resolve());
  assert.ok(first.accepted && second.accepted);
  assert.equal(ledger.get(oldId)?.status, 'cancelled');
  assert.equal((await first.completion).phase, 'cancelled');
  assert.equal((await second.completion).phase, 'queued');
  assert.equal(ledger.latestForAlexa(identity)?.id, second.requestId);
  assert.deepEqual(queue.upcoming.map(item => item.requestId), [second.requestId]);
});
