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
const { runRequest } = await import('../src/broadcast/dj-agent.js');
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

test('when discovery misses the confirmed ID, the agent yields to the constrained fallback', async t => {
  const run = answer(other);
  run.extras.seen.delete(confirmed.id);
  t.mock.method(requestAgent, 'run', async () => run);
  const result = await runRequest(queue, {
    requester: 'anon', text: confirmed.title,
    alexa: { requestId: 'missing', verifiedCandidate: confirmed, isCancelled: () => false },
  });
  assert.equal(result, null);
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
