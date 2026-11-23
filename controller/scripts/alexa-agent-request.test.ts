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
const { createAlexaSkill } = await import('../src/routes/alexa.js');
const { AlexaListenerFeatureService } = await import('../src/alexa/listener-features.js');

const confirmed = { id: 'confirmed', title: 'Crystal Sea', artist: 'River Band', duration: 180 };
const other = { id: 'other', title: 'Granite Sky', artist: 'Mountain Band', duration: 165 };
let runtimeSubmissionSequence = 0;
const dedication = { target: 'the night crew', locale: 'en-IN' as const };
const answer = (pick: typeof confirmed) => ({
  object: { kind: 'track', id: pick.id, ack: 'Found it.', intro: 'Here comes the next track.' },
  steps: 1, toolCalls: [], extras: { seen: new Map([confirmed, other].map(track => [track.id, track])) },
});

function alexaIntent(name: string, attributes: Record<string, unknown> = {}, slots: Record<string, unknown> = {}) {
  const applicationId = 'amzn1.ask.skill.11111111-1111-4111-8111-111111111111';
  return {
    version: '1.0',
    session: {
      new: true,
      sessionId: `SessionId.${name}`,
      application: { applicationId },
      user: { userId: 'amzn1.ask.account.runtime-test' },
      attributes,
    },
    context: {
      System: {
        application: { applicationId },
        user: { userId: 'amzn1.ask.account.runtime-test' },
        device: { deviceId: 'amzn1.ask.device.runtime-test', supportedInterfaces: { AudioPlayer: {} } },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
    },
    request: {
      type: 'IntentRequest',
      requestId: `EdwRequestId.${name}`,
      timestamp: '2026-11-21T12:00:00Z',
      locale: 'en-IN',
      intent: { name, confirmationStatus: 'NONE', slots },
    },
  } as any;
}

function realAlexaRuntime(
  extra: Record<string, unknown> = {},
  captureSubmission?: (identity: string, completion: Promise<any>) => void,
) {
  const identity = `alexa-runtime-integration-${++runtimeSubmissionSequence}`;
  return {
    getSettings: () => ({
      enabled: true,
      skillId: 'amzn1.ask.skill.11111111-1111-4111-8111-111111111111',
      station: 'TEST STATION',
      streamMount: '/stream.mp3',
      streamUrl: 'https://radio.example/stream.mp3',
    }),
    isStreamOnline: () => true,
    submitRequest: async (input: any) => {
      const result = await submitListenerRequest({
        text: input.text,
        name: '',
        ip: `alexa:${identity}`,
        source: 'alexa',
        alexaIdentity: identity,
        verifiedCandidate: input.verifiedCandidate,
      });
      if (!result.accepted) return result;
      captureSubmission?.(identity, result.completion);
      return { accepted: true as const, statusCode: 202 as const, requestId: result.requestId, status: 'pending' as const, completion: result.completion };
    },
    ...extra,
  };
}

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

test('an unresolved MoreLikeThis request returns after a bounded wait and continues without retry or cancellation', async t => {
  const started = deferred();
  const release = deferred();
  let identity: string | undefined;
  let completion: Promise<any> | undefined;
  const agent = t.mock.method(requestAgent, 'run', async () => {
    started.resolve();
    await release.promise;
    return answer(confirmed);
  });
  const skill = createAlexaSkill(realAlexaRuntime({
    listenerFeatures: new AlexaListenerFeatureService({
      nowPlaying: () => ({ id: 'current', title: 'Current Song', artist: 'Current Artist', album: null }),
      recentTracks: () => [],
      similarCandidates: () => [{ id: confirmed.id, title: confirmed.title, artist: confirmed.artist, similarity: 0.95 }],
    }),
  }, (requestIdentity, promise) => { identity = requestIdentity; completion = promise; }) as any);
  let settled = false;
  const responsePromise = skill.invoke(alexaIntent('MoreLikeThisIntent')).then(response => {
    settled = true;
    return response;
  });
  await started.promise;
  const responseOrTimeout = await Promise.race([
    responsePromise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 5_500)),
  ]);
  try {
    assert.ok(responseOrTimeout, 'Alexa must return before its response deadline');
    assert.equal(settled, true);
    const response = responseOrTimeout;
    assert.match((response.response as any).outputSpeech.ssml, /still checking this request/i);
    assert.doesNotMatch((response.response as any).outputSpeech.ssml, /on the way|queued/i);
    assert.equal(queue.upcoming.length, 0);
    assert.ok(identity);
    assert.equal(getLatestAlexaRequestStatus(identity)?.phase, 'pending');
    assert.equal(agent.mock.callCount(), 1);
    assert.ok(completion, 'the accepted shared-pipeline request exposes its live completion');
  } finally {
    release.resolve();
  }
  assert.ok(completion);
  assert.equal((await completion).phase, 'queued');
  assert.equal(agent.mock.callCount(), 1);
  assert.deepEqual(queue.upcoming.map(item => item.track.id), [confirmed.id]);
});

test('a confirmed candidate that fails after admission gets failure speech, not success speech', async t => {
  const run = answer(other);
  run.extras.seen.delete(confirmed.id);
  t.mock.method(requestAgent, 'run', async () => run);
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/search3')) {
      return Response.json({ 'subsonic-response': { status: 'ok', searchResult3: { song: [] } } });
    }
    return new Response(null, { status: 400 });
  });
  const skill = createAlexaSkill(realAlexaRuntime({
    previewRequest: async () => [confirmed, { ...confirmed, id: 'confirmed-alt', album: 'Second album' }],
  }) as any);
  const question = await skill.invoke(alexaIntent('RequestSongIntent', {}, {
    requestText: { name: 'requestText', value: 'Crystal Sea by River Band', confirmationStatus: 'NONE' },
  }));
  assert.match((question.response as any).outputSpeech.ssml, /I found Crystal Sea by River Band/i);
  assert.equal(question.sessionAttributes?.alexaRequestCandidates?.[0]?.id, confirmed.id);
  const confirmation = await skill.invoke({
    ...alexaIntent('AMAZON.YesIntent', question.sessionAttributes || {}),
  } as any);
  const speech = (confirmation.response as any).outputSpeech.ssml;
  assert.match(speech, /nothing in the crates matched/i);
  assert.doesNotMatch(speech, /request was sent|on the way|coming up/i);
  assert.deepEqual(queue.upcoming, []);
});

test('a confirmed candidate reports success only after the actual request is queued', async t => {
  t.mock.method(requestAgent, 'run', async () => answer(confirmed));
  const skill = createAlexaSkill(realAlexaRuntime({
    previewRequest: async () => [confirmed, { ...confirmed, id: 'confirmed-alt', album: 'Second album' }],
  }) as any);
  const question = await skill.invoke(alexaIntent('RequestSongIntent', {}, {
    requestText: { name: 'requestText', value: 'Crystal Sea by River Band', confirmationStatus: 'NONE' },
  }));
  assert.match((question.response as any).outputSpeech.ssml, /I found Crystal Sea by River Band/i);
  const yesEnvelope = alexaIntent('AMAZON.YesIntent', question.sessionAttributes || {});
  const confirmation = await skill.invoke(yesEnvelope);
  assert.match((confirmation.response as any).outputSpeech.ssml, /Your request was sent to the booth/i);
  assert.deepEqual(queue.upcoming.map(item => item.track.id), [confirmed.id]);
});

test('a confirmed candidate cancelled while resolving receives failure speech', async t => {
  const started = deferred();
  const release = deferred();
  let identity: string | undefined;
  let completion: Promise<any> | undefined;
  t.mock.method(requestAgent, 'run', async () => {
    started.resolve();
    await release.promise;
    return answer(confirmed);
  });
  const skill = createAlexaSkill(realAlexaRuntime({
    previewRequest: async () => [confirmed, { ...confirmed, id: 'confirmed-alt', album: 'Second album' }],
  }, (requestIdentity, promise) => { identity = requestIdentity; completion = promise; }) as any);
  const question = await skill.invoke(alexaIntent('RequestSongIntent', {}, {
    requestText: { name: 'requestText', value: 'Crystal Sea by River Band', confirmationStatus: 'NONE' },
  }));
  const confirmationPromise = skill.invoke(alexaIntent('AMAZON.YesIntent', question.sessionAttributes || {}));
  await started.promise;
  try {
    assert.ok(identity);
    assert.equal((await cancelLatestAlexaRequest(identity))?.phase, 'cancelled');
  } finally {
    release.resolve();
  }
  const confirmation = await confirmationPromise;
  assert.match((confirmation.response as any).outputSpeech.ssml, /cancelled by listener/i);
  assert.doesNotMatch((confirmation.response as any).outputSpeech.ssml, /request was sent|on the way/i);
  assert.ok(completion);
  assert.equal((await completion).phase, 'cancelled');
  assert.equal(queue.upcoming.length, 0);
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

test('cancellation during the agent enqueue wait cannot queue the resolved track', async t => {
  let cancellation: Promise<any> | undefined;
  t.mock.method(requestAgent, 'run', async () => {
    // The first microtask lets the agent pass its pre-wait cancellation check;
    // the second runs while waitForCancellation is suspended.
    queueMicrotask(() => queueMicrotask(() => {
      cancellation = cancelLatestAlexaRequest('cancel-during-enqueue-wait');
    }));
    return answer(confirmed);
  });

  const receipt = await submit('cancel-during-enqueue-wait');
  const result = await receipt.completion;
  assert.ok(cancellation, 'the cancellation must run during the enqueue wait');
  assert.equal((await cancellation)?.phase, 'cancelled');
  assert.equal(result.phase, 'cancelled');
  assert.deepEqual(queue.upcoming, []);
  assert.equal(ledger.get(receipt.requestId)?.status, 'cancelled');
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
