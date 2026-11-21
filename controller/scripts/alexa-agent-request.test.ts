import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { beforeEach } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';
import { deferred } from './test-utils/async.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'alexa-agent-request-'));
// Background queue hooks can outlive an individual test. Keep this isolated
// test process offline for their entire lifetime too.
globalThis.fetch = async () => new Response(null, { status: 503 });
const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const ledger = await import('../src/broadcast/request-ledger.js');
const requestLog = await import('../src/broadcast/request-log.js');
const { windowMessages } = await import('../src/broadcast/session.js');
const { submitListenerRequest, cancelLatestAlexaRequest, getLatestAlexaRequestStatus } = await import('../src/routes/request.js');

const confirmed = { id: 'confirmed', title: 'Crystal Sea', artist: 'River Band', duration: 180 };
const other = { id: 'other', title: 'Granite Sky', artist: 'Mountain Band', duration: 165 };
const dedication = { target: 'the night crew', locale: 'en-IN' as const };
const answer = (pick: typeof confirmed) => ({
  object: { kind: 'track', id: pick.id, ack: 'Found it.', intro: 'Here comes the next track.' },
  steps: 1, toolCalls: [], extras: { seen: new Map([confirmed, other].map(track => [track.id, track])) },
});

beforeEach(async () => {
  await settings.load();
  assert.equal(settings.get().llm.requestMatching, 'agentic');
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.history = [];
  queue.current = null;
});

async function submit(identity: string, verify = false) {
  const receipt = await submitListenerRequest({
    text: 'Crystal Sea by River Band', name: '', ip: identity, source: 'alexa', alexaIdentity: identity,
    dedication, verifiedCandidate: verify ? confirmed : undefined,
  });
  assert.ok(receipt.accepted, JSON.stringify(receipt));
  return receipt;
}

test('agent-queued Alexa dedications can be found and cancelled by their receipt', async t => {
  const model = t.mock.method(requestAgent, 'run', async () => answer(confirmed));
  const receipt = await submit('dedication-listener');
  assert.equal((await receipt.completion).phase, 'queued');
  assert.equal(model.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(model.mock.calls[0].arguments), /the night crew/);
  const [item] = queue.upcoming;
  assert.equal(item.requestId, receipt.requestId);
  assert.deepEqual(item.dedication, dedication);
  assert.match(item.introScript || '', /This one is dedicated to the night crew\./);
  assert.doesNotMatch(JSON.stringify(windowMessages()), /the night crew/);
  assert.equal(getLatestAlexaRequestStatus('dedication-listener')?.queuePosition, 1);
  assert.equal((await cancelLatestAlexaRequest('dedication-listener'))?.phase, 'cancelled');
  assert.equal(queue.upcoming.length, 0);
});

test('a conflicting model pick cannot replace an observed, confirmed Alexa candidate', async t => {
  const model = t.mock.method(requestAgent, 'run', async () => answer(other));
  const receipt = await submit('confirmed-listener', true);
  const result = await receipt.completion;
  assert.equal(model.mock.callCount(), 1);
  assert.equal(result.track?.id, confirmed.id);
  assert.deepEqual(queue.upcoming.map(item => item.track.id), [confirmed.id]);
});

test('a submission fails when the agent misses the confirmed ID and direct search finds another recording', async t => {
  const run = answer(other);
  run.extras.seen.delete(confirmed.id);
  const agent = t.mock.method(requestAgent, 'run', async () => run);
  let searches = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/search3')) {
      searches++;
      // Identical catalogue names, different recording ID.
      return Response.json({ 'subsonic-response': { status: 'ok', searchResult3: {
        song: [{ ...confirmed, id: 'other-recording' }],
      } } });
    }
    return new Response(null, { status: 400 });
  });
  const receipt = await submit('missing-listener', true);
  const result = await receipt.completion;
  assert.equal(agent.mock.callCount(), 1);
  assert.ok(searches > 0);
  const log = requestLog.recentRequests.find(row => row.id === receipt.requestId.slice(0, 8));
  assert.match(log?.pickSource || '', /:verified-candidate-mismatch$/);
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'no-match');
  assert.equal(ledger.get(receipt.requestId)?.track, null);
  assert.deepEqual(queue.upcoming, []);
});

test('cancelling an accepted Alexa request while the model is resolving leaves the queue empty', async t => {
  const started = deferred();
  const release = deferred();
  t.mock.method(requestAgent, 'run', async () => {
    started.resolve();
    await release.promise;
    return answer(confirmed);
  });
  const receipt = await submit('cancel-listener');
  await started.promise;
  try {
    assert.equal((await cancelLatestAlexaRequest('cancel-listener'))?.phase, 'cancelled');
  } finally {
    release.resolve();
  }
  assert.equal((await receipt.completion).phase, 'cancelled');
  assert.equal(queue.upcoming.length, 0);
});

test('an aged pending receipt remains cancellable after another submission prunes the request map', async t => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  t.mock.method(requestAgent, 'run', async () => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
      return answer(confirmed);
    }
    return answer(other);
  });
  const receipt = await submit('slow-listener');
  await started.promise;
  const later = Date.now() + 11 * 60_000;
  t.mock.method(Date, 'now', () => later);
  try {
    const trigger = await submit('prune-listener');
    assert.equal((await trigger.completion).phase, 'queued');
    assert.equal((await cancelLatestAlexaRequest('slow-listener'))?.phase, 'cancelled');
  } finally {
    release.resolve();
  }
  assert.equal((await receipt.completion).phase, 'cancelled');
  assert.equal(ledger.get(receipt.requestId)?.status, 'cancelled');
  assert.deepEqual(queue.upcoming.map(item => item.track.id), [other.id]);
});

test('a refused player removal preserves the queued receipt and its one-pending hold', async t => {
  await settings.update({ requests: { onePendingPerIp: true } } as never);
  t.mock.method(requestAgent, 'run', async () => answer(confirmed));
  const identity = 'player-listener';
  const receipt = await submit(identity);
  assert.equal((await receipt.completion).phase, 'queued');
  t.mock.method(queue, 'removeUpcomingRequest', async () => ({ ok: false, reason: 'already-playing' }));
  const status = await cancelLatestAlexaRequest(identity);
  assert.equal(status?.status, 'resolved');
  assert.equal(status.phase, 'queued');
  assert.equal(ledger.get(receipt.requestId)?.status, 'resolved');
  assert.deepEqual(queue.upcoming.map(item => item.requestId), [receipt.requestId]);
  // Past the receipt TTL and the per-listener cooldown, only the queued hold applies.
  const later = Date.now() + 11 * 60_000;
  t.mock.method(Date, 'now', () => later);
  const retry = await submitListenerRequest({ text: 'Another song', name: '', ip: identity, source: 'alexa', alexaIdentity: identity });
  assert.ok(!retry.accepted);
  assert.match(retry.message || '', /last request is still queued/);
});
