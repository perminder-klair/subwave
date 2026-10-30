// POST /onboarding/test-llm builds the client for the provider the wizard
// names. A provider with no case of its own used to fall through to the Ollama
// default, so testing Vercel AI Gateway asked localhost:11434 and failed with
// an Ollama error the operator could do nothing about.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the router mounts
// bare over real HTTP against a temp state dir. Outbound provider calls are
// caught by a fetch stub; the test's own calls to the router pass through.
//
// Run: `npm test -- onboarding-test-llm`.

import assert from 'node:assert/strict';
import { listen as listenHttp } from './test-utils/http.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-onboarding-test-llm-'));
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
delete process.env.AI_GATEWAY_API_KEY;

const express = (await import('express')).default;
const { router } = await import('../src/routes/onboarding.js');

const app = express();
app.use(express.json());
app.use(router);
const { server, url: base } = await listenHttp(app);
server.unref();

test('gateway is tested against Vercel AI Gateway, not the Ollama default', async (t) => {
  const realFetch = globalThis.fetch;
  const outbound: { url: string; auth: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', (async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (target.startsWith(base)) return realFetch(url, init);
    outbound.push({ url: target, auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ error: { message: 'stubbed', type: 'authentication_error' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);

  const res = await fetch(`${base}/onboarding/test-llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'gateway', model: 'openai/gpt-5-mini', apiKey: 'gw-test-key' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean };
  assert.equal(body.ok, false);

  assert.ok(outbound.length > 0, 'the test reached no provider');
  for (const call of outbound) {
    assert.match(call.url, /^https:\/\/ai-gateway\.vercel\.sh\//);
    assert.doesNotMatch(call.url, /11434/);
    assert.equal(call.auth, 'Bearer gw-test-key');
  }
});
