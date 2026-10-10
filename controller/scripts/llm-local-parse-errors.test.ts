// A local parse failure is never a provider verdict.
//
// djObject's text-recovery leg parses the model's own reply, and V8's
// JSON.parse message quotes that reply. The failover/retry classifiers read
// error MESSAGES (quota, auth, overload, host-down wording), so a reply that
// merely said "Forbidden" or "quota" used to read as the provider refusing the
// leg — failing over to the backup and, in a two-model tag run, dropping the
// leg for the rest of the run. Two layers guard it: the recovery throw carries a
// fixed message, and the classifiers ignore SyntaxError/ZodError messages.
//
// Run: npm test -- llm-local-parse-errors

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { z } from 'zod';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-local-parse-errors-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { primaryLeg, fallbackLeg } = await import('../src/llm/internal/provider/legs.js');
const { djObject } = await import('../src/llm/sdk.js');
const pure = await import('../src/llm/internal/core/pure.js');
after(() => rmSync(stateRoot, { recursive: true, force: true }));

// The classifiers take a duck-typed ErrorLike; real Error objects are passed as-is.
const syntaxErrorOf = (text: string): any => {
  try { JSON.parse(text); } catch (err) { return err; }
  throw new Error('expected a parse failure');
};

test('classifiers ignore the model text a SyntaxError or ZodError quotes', () => {
  // The real thing first: V8 quotes the reply around the failure point.
  const real = syntaxErrorOf('{"name": Forbidden Colours}');
  assert.match(real.message, /Forbidden/, 'precondition: V8 quotes the input');
  assert.equal(pure.isQuotaOrAuthError(real), false);
  for (const text of ['Forbidden Colours', 'quota of joy', 'Unauthorized love', 'fetch failed me', 'overloaded heart', 'too many requests 429 times', 'model was retired', '503 nights']) {
    const err: any = new SyntaxError(`Unexpected token, "{"name": ${text}"... is not valid JSON`);
    assert.equal(pure.isQuotaOrAuthError(err), false, text);
    assert.equal(pure.isUnreachable(err), false, text);
    assert.equal(pure.isUpstreamOverloaded(err), false, text);
    assert.equal(pure.isRateLimited(err), false, text);
    assert.equal(pure.isModelUnavailable(err), false, text);
    assert.equal(pure.isTransient(err), false, text);
  }
  const zodErr: any = z.object({ a: z.literal('x') }).safeParse({ a: 'Forbidden' }).error!;
  zodErr.message = `${zodErr.message} Forbidden quota`;
  assert.equal(pure.isQuotaOrAuthError(zodErr), false);
  // A wrapper whose own message is empty does not borrow its parse cause's.
  assert.equal(pure.isQuotaOrAuthError({ message: '', cause: syntaxErrorOf('Forbidden') }), false);
});

test('real provider errors still classify', () => {
  assert.equal(pure.isQuotaOrAuthError(new Error('403 Forbidden: invalid api key') as any), true);
  assert.equal(pure.isQuotaOrAuthError({ message: '', cause: { message: 'You exceeded your current quota' } }), true);
  assert.equal(pure.isUnreachable(new Error('connect ECONNREFUSED 127.0.0.1:11434') as any), true);
  assert.equal(pure.isUpstreamOverloaded(new Error('upstream error: overloaded') as any), true);
  assert.equal(pure.isTransient(new Error('HTTP 503 Service Unavailable') as any), true);
});

test('a recovery reply that fails to parse does not fail over, and keeps its text', async (t) => {
  const defaults = settings.getDefaults();
  store.setCache({ ...defaults, llm: {
    ...defaults.llm, provider: 'openai', model: 'parse-primary',
    fallback: { ...defaults.llm.fallback, enabled: true, provider: 'openai', model: 'parse-backup' },
  } });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected provider traffic'); });
  const primary = primaryLeg();
  const backup = fallbackLeg();
  assert.ok(backup);
  const reply = {
    content: [{ type: 'text' as const, text: '{"name": Forbidden Colours}' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    warnings: [],
  };
  for (const model of new Set([primary.model, primary.noThinkModel])) t.mock.method(model as any, 'doGenerate', async () => reply);
  let backupCalls = 0;
  for (const model of new Set([backup!.model, backup!.noThinkModel])) {
    t.mock.method(model as any, 'doGenerate', async () => { backupCalls++; return reply; });
  }

  const err: any = await djObject({ system: 's', prompt: 'p', schema: z.object({ name: z.string() }), kind: 'parse-test' })
    .then(() => null, (e: unknown) => e);
  assert.ok(err, 'the call fails');
  assert.equal(backupCalls, 0, 'a reply that mentions "Forbidden" is not an auth rejection');
  assert.doesNotMatch(String(err.message), /Forbidden/);
  assert.equal(err.text, '{"name": Forbidden Colours}', 'raw output still rides along for /debug');
  assert.equal(err.cause?.name, 'SyntaxError');
});
