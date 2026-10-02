// Exercise the merged generation guard and Gemini safety channel together
// through the real Google adapter. All fetches are intercepted.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { z } from 'zod';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-generation-google-'));
process.env.STATE_DIR = stateRoot;
after(() => rmSync(stateRoot, { recursive: true, force: true }));

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { djObject } = await import('../src/llm/sdk.js');
const { recentCalls, generationHealthSnapshot } = await import('../src/llm/log.js');
const schema = z.object({ ok: z.boolean() });
const primaryFlags = { harassment: true, hateSpeech: false, sexuallyExplicit: true, dangerousContent: false };
const backupFlags = { harassment: false, hateSpeech: true, sexuallyExplicit: false, dangerousContent: true };
const primaryThresholds = ['BLOCK_NONE', 'BLOCK_NONE', 'BLOCK_MEDIUM_AND_ABOVE', 'BLOCK_MEDIUM_AND_ABOVE'];
const backupThresholds = ['BLOCK_MEDIUM_AND_ABOVE', 'BLOCK_MEDIUM_AND_ABOVE', 'BLOCK_NONE', 'BLOCK_NONE'];

interface CapturedRequest {
  url: string;
  body: { safetySettings: { category: string; threshold: string }[] };
  signal: AbortSignal;
}

async function withRequests(
  responses: ('invalid' | 'stalled' | 'ok')[],
  run: (requests: CapturedRequest[]) => Promise<void>,
  onStall?: () => void,
) {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'google', model: 'gemini-2.5-flash', keys: { google: 'test-key' },
    geminiSafety: primaryFlags, requestTimeoutMs: 5000,
    fallback: { enabled: true, provider: 'google', model: 'gemini-2.5-pro', geminiSafety: backupFlags },
  } }));
  setCache(null);
  await settings.load();
  // Only the isolated test cache gets a short budget; production clamps remain.
  settings.get().llm.requestTimeoutMs = 100;
  recentCalls.length = 0;
  const requests: CapturedRequest[] = [];
  const stalled: ReadableStreamDefaultController<Uint8Array>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    const response = responses[requests.length];
    assert.ok(response, 'unexpected retry, recovery, or fallback request');
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init!.signal! });
    assert.equal(new URL(String(url)).hostname, 'generativelanguage.googleapis.com');
    if (response === 'stalled') {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"candidates":'));
        stalled.push(controller);
      } });
      // Ignore transport abort deliberately: the guard must bound body reading.
      if (onStall) setImmediate(onStall);
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: response === 'invalid' ? 'not JSON' : '{"ok":true}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = realFetch;
    for (const controller of stalled) controller.close();
  }
}

function thresholds(request: CapturedRequest) {
  return request.body.safetySettings.map(setting => setting.threshold);
}

test('Gemini schema recovery keeps the primary safety thresholds under the generation guard', async () => {
  await withRequests(['invalid', 'ok'], async requests => {
    assert.deepEqual(await djObject({ prompt: 'test', schema }), { ok: true });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.url.includes('gemini-2.5-flash')));
    for (const request of requests) assert.deepEqual(thresholds(request), primaryThresholds);
    assert.equal(recentCalls.length, 1);
    assert.equal(recentCalls[0].via, 'ai-sdk:recovery');
    assert.equal(generationHealthSnapshot().inFlightCount, 0);
  });
});

test('a stalled Gemini recovery body aborts and fails over once with independent fallback safety', async () => {
  await withRequests(['invalid', 'stalled', 'ok'], async requests => {
    assert.deepEqual(await djObject({ prompt: 'test', schema }), { ok: true });
    assert.equal(requests.length, 3);
    assert.deepEqual(thresholds(requests[0]), primaryThresholds);
    assert.deepEqual(thresholds(requests[1]), primaryThresholds);
    assert.deepEqual(thresholds(requests[2]), backupThresholds);
    assert.ok(requests[2].url.includes('gemini-2.5-pro'));
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(requests[1].signal.reason.code, 'PROVIDER_REQUEST_TIMEOUT');
    assert.equal(recentCalls.length, 2);
    assert.equal(recentCalls.filter(call => call.ok).length, 1);
    assert.match(recentCalls.find(call => !call.ok)!.via, /^ai-sdk:recovery:failover/);
    assert.equal(generationHealthSnapshot().inFlightCount, 0);
  });
});

test('Gemini caller cancellation aborts body reading without schema recovery or provider failover', async () => {
  const caller = new AbortController();
  const reason = new Error('caller budget expired');
  await withRequests(['stalled'], async requests => {
    await assert.rejects(djObject({ prompt: 'test', schema, signal: caller.signal }), (error: any) =>
      error.code === 'GENERATION_CANCELLED' && error.cause === reason);
    assert.equal(requests.length, 1);
    assert.deepEqual(thresholds(requests[0]), primaryThresholds);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(recentCalls.length, 1);
    assert.equal(recentCalls[0].ok, false);
    assert.equal(generationHealthSnapshot().inFlightCount, 0);
  }, () => caller.abort(reason));
});
