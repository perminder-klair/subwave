// Unit tests for the pure LLM helpers — the regression-critical bits of the
// llm/ rewrite. Run: `npm run test:llm` (tsx scripts/llm-pure.test.ts).
//
// These functions are side-effect-free and unit-pinned here so a wiring slip
// (a provider routed to the wrong path, a thinking knob flipped, the failover
// gate widened) fails an assert BEFORE it ever reaches a model. Matches the
// node:assert-via-tsx style of scripts/picker-recency-regression.test.ts.

import assert from 'node:assert/strict';
import { generateText, APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { stripThinking, extractJson, usageOf, budgetMode, isUnreachable, isTransient, isQuotaOrAuthError, isUpstreamOverloaded, isRateLimited, errReason, nearestId } from '../src/llm/internal/core/pure.js';
import { withDeadline, withTransientRetry, retryAfterMs } from '../src/llm/internal/core/retry.js';
import { providerOptions, needsToolCallObject, repeatPenaltyApplies, appliedNumCtx, appliedRepeatPenalty, forcedToolChoice } from '../src/llm/internal/provider/capabilities.js';
import { agentPlan } from '../src/llm/internal/strategy/plan.js';
import { introBudgetPhrase, enforceIntroBudget } from '../src/llm/internal/prompts/intro-budget.js';
import { embeddingBaseUrl } from '../src/llm/internal/provider/embedding.js';
import { DEFAULT_LOCCA_EMBED_BASE_URL, openAICompatibleFetch } from '../src/llm/internal/provider/registry.js';
import { personaToneDirectives, normalizeDial, DIAL_NEUTRAL, validatePersonasStrict, clampTtsSpeed, TTS_SPEED_DEFAULT, clampMaxOutputTokens, resolveMaxOutputTokens, MAX_OUTPUT_TOKENS_MIN, MAX_OUTPUT_TOKENS_MAX, effectiveFrequency, SCRIPT_LENGTHS } from '../src/settings.js';
import { lengthMode, lengthPhrase } from '../src/llm/internal/prompts/system.js';
import { showMusicLean } from '../src/llm/internal/prompts/picker.js';
import { resolveCloudModel } from '../src/llm/internal/speech/cloud-speech.js';
import { isElevenLabsV3 } from '../src/llm/internal/prompts/system.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  // ---- failover gate: isUnreachable ⊂ isTransient, but EXCLUDES 5xx/429 ----
  console.log('isUnreachable vs isTransient (the failover gate):');
  await test('500 is transient but NOT unreachable', () => {
    assert.equal(isTransient({ statusCode: 500 }), true);
    assert.equal(isUnreachable({ statusCode: 500 }), false);
  });
  await test('bare 429 (no quota signature) is transient, NOT unreachable, NOT quota/auth', () => {
    assert.equal(isTransient({ statusCode: 429 }), true);
    assert.equal(isUnreachable({ statusCode: 429 }), false);
    assert.equal(isQuotaOrAuthError({ statusCode: 429 }), false);
  });
  await test('ECONNREFUSED is both transient and unreachable', () => {
    assert.equal(isTransient({ code: 'ECONNREFUSED' }), true);
    assert.equal(isUnreachable({ code: 'ECONNREFUSED' }), true);
  });
  await test('ENOTFOUND is unreachable (DNS down)', () => {
    assert.equal(isUnreachable({ code: 'ENOTFOUND' }), true);
  });
  await test('cause.code is unwrapped', () => {
    assert.equal(isUnreachable({ cause: { code: 'ECONNREFUSED' } }), true);
  });
  await test('AgentDeadlineError is NOT unreachable (model overthinking ≠ host down)', async () => {
    const e: any = new Error('x exceeded 1000ms deadline');
    e.name = 'AgentDeadlineError';
    assert.equal(isUnreachable(e), false);
    assert.equal(isTransient(e), false);
    // And the real withDeadline produces exactly that error.
    const thrown = await withDeadline(20, 'race', () => new Promise<never>(() => {})).catch((x) => x);
    assert.equal(thrown.name, 'AgentDeadlineError');
    assert.equal(isUnreachable(thrown), false);
  });

  // ---- quota/auth gate: failover-eligible, pulled OUT of same-leg retry (#438) ----
  console.log('isQuotaOrAuthError (quota/usage-limit/auth → fail over, not retry):');
  await test('Ollama Cloud weekly usage-limit 429 → quota/auth, NOT transient', () => {
    // The exact shape from issue #438: status 429 + a usage-limit message.
    const e: any = { statusCode: 429, message: 'you (acct) have reached your weekly usage limit, upgrade for higher limits: https://ollama.com/upgrade (ref: abc)' };
    assert.equal(isQuotaOrAuthError(e), true);
    assert.equal(isTransient(e), false);   // pulled OUT of same-leg retry
    assert.equal(isUnreachable(e), false);  // host is up, just refusing
  });
  await test('quota message with no status still classifies (AI SDK flattens status)', () => {
    const e: any = new Error('Insufficient quota — upgrade for higher limits');
    assert.equal(isQuotaOrAuthError(e), true);
    assert.equal(isTransient(e), false);
  });
  await test('401/403 are quota/auth (bad/missing API key never recovers on this leg)', () => {
    assert.equal(isQuotaOrAuthError({ statusCode: 401 }), true);
    assert.equal(isQuotaOrAuthError({ statusCode: 403 }), true);
    assert.equal(isQuotaOrAuthError({ message: 'Incorrect API key provided' }), true);
    assert.equal(isTransient({ statusCode: 401 }), false);
  });
  await test('cause.statusCode / cause.message are unwrapped', () => {
    assert.equal(isQuotaOrAuthError({ cause: { statusCode: 402 } }), true);
    assert.equal(isQuotaOrAuthError({ cause: { message: 'quota exceeded' } }), true);
  });
  await test('OpenRouter out-of-credit 402 classifies by message when status is flattened', () => {
    // Canonical 402 — caught by the existing insufficient-credit branch.
    assert.equal(isQuotaOrAuthError(new Error('Your account or API key has insufficient credits. Add more credits and retry the request.')), true);
    // Per-request affordability 402 — no "insufficient"/"quota" token, so before
    // this it classified ONLY while the 402 status survived (Discord: run died as
    // "unreachable" once the SDK flattened the status into the message).
    const afford: any = new Error('This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 118.');
    assert.equal(isQuotaOrAuthError(afford), true);
    assert.equal(isTransient(afford), false);    // fail over, not same-leg retry
    assert.equal(isUnreachable(afford), false);   // host answered — not a network outage
  });
  await test('plain 5xx / socket errors are NOT quota/auth (still same-leg retry)', () => {
    assert.equal(isQuotaOrAuthError({ statusCode: 503 }), false);
    assert.equal(isQuotaOrAuthError({ code: 'ECONNRESET' }), false);
  });

  // ---- upstream-overload gate: STAYS transient (retry first), THEN fails over (#671) ----
  console.log('isUpstreamOverloaded (reachable gateway relays a saturated upstream → retry, then fail over):');
  await test('OpenRouter "Upstream error from <provider>: ResourceExhausted" → upstream-overload', () => {
    // The exact shape from issue #671: OpenRouter relaying a saturated Nvidia upstream.
    const e: any = { statusCode: 429, message: 'Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (32/32)' };
    assert.equal(isUpstreamOverloaded(e), true);
    assert.equal(isTransient(e), true);          // stays transient — a brief blip clears on the chosen model
    assert.equal(isUnreachable(e), false);        // gateway answered, host is up
    assert.equal(isQuotaOrAuthError(e), false);   // not the user's quota — the upstream is saturated
  });
  await test('Anthropic 529 "Overloaded" → upstream-overload (529 is outside the transient status set)', () => {
    assert.equal(isUpstreamOverloaded({ statusCode: 529 }), true);
    assert.equal(isUpstreamOverloaded({ message: 'Overloaded' }), true);
  });
  await test('gRPC RESOURCE_EXHAUSTED / "no instances available" → upstream-overload', () => {
    assert.equal(isUpstreamOverloaded({ message: 'RESOURCE_EXHAUSTED: model is overloaded' }), true);
    assert.equal(isUpstreamOverloaded({ message: 'No instances available for this model' }), true);
  });
  await test('cause.message / cause.statusCode are unwrapped', () => {
    assert.equal(isUpstreamOverloaded({ cause: { message: 'Upstream error from Together: overloaded' } }), true);
    assert.equal(isUpstreamOverloaded({ cause: { statusCode: 529 } }), true);
  });
  await test('plain 503 / quota / socket errors are NOT upstream-overload (no false failover)', () => {
    assert.equal(isUpstreamOverloaded({ statusCode: 503 }), false);
    assert.equal(isUpstreamOverloaded({ statusCode: 429, message: 'rate limit exceeded, slow down' }), false);
    assert.equal(isUpstreamOverloaded({ code: 'ECONNRESET' }), false);
    assert.equal(isUpstreamOverloaded(null), false);
  });

  // ---- rate-limit gate: STAYS transient (retry first), THEN fails over (#738) ----
  console.log('isRateLimited (rate-limit 429 → retry, then fail over to keep a free tier on air):');
  await test('a 429 with a plain "rate limit" message → rate-limited, stays transient, not quota/auth', () => {
    const e: any = { statusCode: 429, message: 'rate limit exceeded, slow down' };
    assert.equal(isRateLimited(e), true);
    assert.equal(isTransient(e), true);
    assert.equal(isQuotaOrAuthError(e), false);
    assert.equal(isUnreachable(e), false);
  });
  await test('real provider shapes: OpenAI RPM / Gemini per-day / Groq TPM messages classify', () => {
    assert.equal(isRateLimited({ statusCode: 429, message: 'Rate limit reached for gpt-4o in organization org-x on requests per min (RPM): Limit 3, Used 3' }), true);
    assert.equal(isRateLimited({ statusCode: 429, message: 'Resource has been exhausted (e.g. check quota): too many requests per day' }), true);
    assert.equal(isRateLimited({ statusCode: 429, message: 'Rate limit exceeded for requests per minute' }), true);
  });
  await test('a bare 429 with a Retry-After header but no wording → rate-limited', () => {
    assert.equal(isRateLimited({ statusCode: 429, responseHeaders: { 'retry-after': '20' } }), true);
    assert.equal(isRateLimited({ statusCode: 429, responseHeaders: { 'retry-after-ms': '500' } }), true);
  });
  await test('a bare 429 with NO wording and NO header (self-hosted concurrency spike) does NOT fail over', () => {
    // llama.cpp/vLLM/LiteLLM answering 429 on a momentary slot conflict must
    // stay a same-leg transient retry — never silently switch the station onto
    // a possibly-paid cloud fallback (PR #751 review).
    assert.equal(isRateLimited({ statusCode: 429 }), false);
    assert.equal(isTransient({ statusCode: 429 }), true);
  });
  await test('an AI_RetryError wrapper (SDK maxRetries spent) is unwrapped to the real 429', () => {
    // What djText/djObject/djAgent actually receive: the SDK retried
    // internally, then threw a wrapper with NO statusCode of its own — the
    // real APICallError lives in errors[]/lastError (PR #751 review).
    const inner: any = { statusCode: 429, message: 'Rate limit reached for gpt-4o', responseHeaders: { 'retry-after': '20' } };
    const wrapper: any = new Error('Failed after 3 attempts. Last error: Rate limit reached for gpt-4o');
    wrapper.reason = 'maxRetriesExceeded';
    wrapper.errors = [inner, inner];
    wrapper.lastError = inner;
    assert.equal(isRateLimited(wrapper), true);
    assert.equal(isTransient(wrapper), true);
    assert.equal(isQuotaOrAuthError(wrapper), false);
  });
  await test('a wrapped quota/auth error still classifies as quota/auth through the wrapper', () => {
    const inner: any = { statusCode: 429, message: 'you have reached your weekly usage limit' };
    const wrapper: any = new Error('Failed after 3 attempts. Last error: weekly usage limit');
    wrapper.errors = [inner];
    wrapper.lastError = inner;
    assert.equal(isQuotaOrAuthError(wrapper), true);
    assert.equal(isTransient(wrapper), false);
  });
  await test('cause.statusCode is unwrapped', () => {
    assert.equal(isRateLimited({ cause: { statusCode: 429, message: 'too many requests' } }), true);
  });
  await test('non-429 errors are NOT rate-limited', () => {
    assert.equal(isRateLimited({ statusCode: 503 }), false);
    assert.equal(isRateLimited({ code: 'ECONNRESET' }), false);
    assert.equal(isRateLimited(null), false);
  });

  // ---- retryAfterMs: parses a provider's Retry-After header (#738) ----
  console.log('retryAfterMs (Retry-After header sets the same-leg retry delay; raw, uncapped):');
  await test('a numeric Retry-After (seconds) converts to ms', () => {
    assert.equal(retryAfterMs({ responseHeaders: { 'retry-after': '1' } }), 1000);
    assert.equal(retryAfterMs({ responseHeaders: { 'retry-after': '5' } }), 5000);
  });
  await test('returns the RAW duration uncapped — the caller decides to wait or fail over', () => {
    assert.equal(retryAfterMs({ responseHeaders: { 'retry-after': '3600' } }), 3_600_000);
  });
  await test('OpenAI retry-after-ms takes precedence over retry-after', () => {
    assert.equal(retryAfterMs({ responseHeaders: { 'retry-after-ms': '250', 'retry-after': '2' } }), 250);
  });
  await test('an AI_RetryError wrapper is unwrapped to reach the header', () => {
    const inner: any = { statusCode: 429, responseHeaders: { 'retry-after': '20' } };
    const wrapper: any = new Error('Failed after 3 attempts');
    wrapper.errors = [inner];
    wrapper.lastError = inner;
    assert.equal(retryAfterMs(wrapper), 20_000);
  });
  await test('cause.responseHeaders is unwrapped', () => {
    assert.equal(retryAfterMs({ cause: { responseHeaders: { 'retry-after': '2' } } }), 2000);
  });
  await test('missing header, zero, or garbage value → null (falls back to the default delay)', () => {
    assert.equal(retryAfterMs({}), null);
    assert.equal(retryAfterMs({ responseHeaders: {} }), null);
    assert.equal(retryAfterMs({ responseHeaders: { 'retry-after': '0' } }), null);
    assert.equal(retryAfterMs({ responseHeaders: { 'retry-after': 'not-a-date' } }), null);
    assert.equal(retryAfterMs(null), null);
  });

  // ---- withTransientRetry: wires retryAfterMs into the actual retry loop ----
  console.log('withTransientRetry (waits out a short Retry-After; gives up the leg on a long one):');
  await test('a 429 with Retry-After: 1 waits ~1000ms instead of the default 500ms', async () => {
    let calls = 0;
    const started = Date.now();
    await withTransientRetry('test', async () => {
      calls++;
      if (calls === 1) {
        const err: any = new Error('rate limit exceeded, slow down');
        err.statusCode = 429;
        err.responseHeaders = { 'retry-after': '1' };
        throw err;
      }
      return 'ok';
    });
    const elapsed = Date.now() - started;
    assert.equal(calls, 2);
    assert.ok(elapsed >= 950, `expected a ~1000ms wait, got ${elapsed}ms`);
  });
  await test('a Retry-After beyond the same-leg budget throws IMMEDIATELY (→ withFailover tries the backup)', async () => {
    let calls = 0;
    const started = Date.now();
    const err: any = new Error('rate limit exceeded');
    err.statusCode = 429;
    err.responseHeaders = { 'retry-after': '3600' };
    const thrown = await withTransientRetry('test', async () => { calls++; throw err; }).catch((x) => x);
    const elapsed = Date.now() - started;
    assert.equal(thrown, err);
    assert.equal(calls, 1);                        // no second same-leg attempt
    assert.ok(elapsed < 500, `expected an immediate throw, got ${elapsed}ms`);
  });
  await test('an aborted signal stops the backoff sleep and further attempts', async () => {
    let calls = 0;
    const controller = new AbortController();
    const started = Date.now();
    const err: any = new Error('service unavailable');
    err.statusCode = 503;
    const run = withTransientRetry('test', async () => { calls++; throw err; }, controller.signal).catch((x) => x);
    setTimeout(() => controller.abort(), 50);       // fire mid-backoff (first delay is ~500ms)
    const thrown = await run;
    const elapsed = Date.now() - started;
    assert.equal(thrown, err);
    assert.equal(calls, 1);
    assert.ok(elapsed < 400, `expected the abort to cut the ~500ms sleep short, got ${elapsed}ms`);
  });
  await test('no Retry-After header falls back to the default jittered delay', async () => {
    let calls = 0;
    await withTransientRetry('test', async () => {
      calls++;
      if (calls === 1) {
        const err: any = new Error('service unavailable');
        err.statusCode = 503;
        throw err;
      }
      return 'ok';
    });
    assert.equal(calls, 2);
  });

  // ---- real AI SDK error shapes: generateText + mock transport (PR #751 review) ----
  // The synthetic literals above pin the classifier logic; this pins the SHAPE.
  // A real generateText call retries internally (default maxRetries: 2) and
  // throws AI_RetryError — a wrapper with no statusCode/responseHeaders of its
  // own. The classifiers must see through it or none of this fires in prod.
  console.log('real AI SDK shapes (generateText throws AI_RetryError wrapping APICallError):');
  await test('a real 429 APICallError from generateText classifies through the RetryError wrapper', async () => {
    const rateLimit429 = new APICallError({
      message: 'Rate limit reached for gpt-4o on requests per min (RPM): Limit 3, Used 3',
      url: 'https://api.openai.com/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
      // retry-after: 0 keeps the SDK's own honoured waits at 0ms so the test is fast.
      responseHeaders: { 'retry-after': '0' },
    });
    const model = new MockLanguageModelV3({
      doGenerate: () => { throw rateLimit429; },
    });
    const thrown: any = await generateText({ model, prompt: 'hi' }).catch((x) => x);
    assert.equal(thrown?.name, 'AI_RetryError');            // proves the wrapper shape
    assert.equal(thrown?.statusCode, undefined);            // …with no status of its own
    assert.equal(isRateLimited(thrown), true);              // unwrap finds the real 429
    assert.equal(isTransient(thrown), true);
    assert.equal(isQuotaOrAuthError(thrown), false);
    assert.equal(isUnreachable(thrown), false);
    assert.equal(retryAfterMs(thrown), null);               // '0' → no forced wait, default delay
  });
  await test('a real quota 429 through the wrapper still routes to quota/auth (issue #438 preserved)', async () => {
    const quota429 = new APICallError({
      message: 'you have reached your weekly usage limit, upgrade for higher limits',
      url: 'https://ollama.com/api/chat',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'retry-after': '0' },
    });
    const model = new MockLanguageModelV3({ doGenerate: () => { throw quota429; } });
    const thrown: any = await generateText({ model, prompt: 'hi' }).catch((x) => x);
    assert.equal(thrown?.name, 'AI_RetryError');
    assert.equal(isQuotaOrAuthError(thrown), true);
    assert.equal(isTransient(thrown), false);
  });

  // ---- errReason: turn undici's opaque "fetch failed" into an actionable log ----
  console.log('errReason (log-friendly cause; digs the errno out of err.cause):');
  await test('undici "fetch failed" surfaces the errno from err.cause.code, not "unknown"', () => {
    // The Discord shape: the request never reached OpenRouter, so there is no
    // HTTP status — the real reason (ECONNRESET / ENOTFOUND / ETIMEDOUT) is on
    // the cause. The old retry log only read err.code and printed "unknown".
    const e: any = new TypeError('fetch failed');
    e.cause = { code: 'ECONNRESET' };
    assert.equal(errReason(e), 'fetch failed (ECONNRESET)');
    const dns: any = new TypeError('fetch failed');
    dns.cause = { code: 'ENOTFOUND' };
    assert.equal(errReason(dns), 'fetch failed (ENOTFOUND)');
  });
  await test('prefers a status when there is no errno, and never double-prints', () => {
    assert.equal(errReason({ statusCode: 503 }), '503');
    assert.equal(errReason({ message: '503 Service Unavailable', statusCode: 503 }), '503 Service Unavailable');
    assert.equal(errReason(new Error('Insufficient credits. Add more credits and retry.')), 'Insufficient credits. Add more credits and retry.');
    assert.equal(errReason(null), 'unknown');
  });

  // ---- per-provider thinking knob (the single most regression-prone mapping) ----
  console.log('providerOptions(cfg, {reasoning, forceNoThink}):');
  await test('ollama: think tracks raw reasoning toggle', () => {
    assert.deepEqual(providerOptions({ provider: 'ollama', model: 'qwen3', reasoning: false }), { ollama: { think: false } });
    assert.deepEqual(providerOptions({ provider: 'ollama', model: 'qwen3', reasoning: true }), { ollama: { think: true } });
  });
  await test('ollama: repeat_penalty + num_ctx ride in options (local only)', () => {
    assert.deepEqual(
      providerOptions({ provider: 'ollama', model: 'qwen3', numCtx: 16384 }, { repeatPenalty: 1.2 }),
      { ollama: { think: false, options: { repeat_penalty: 1.2, num_ctx: 16384 } } },
    );
    // :cloud models manage their own context — no num_ctx.
    assert.deepEqual(
      providerOptions({ provider: 'ollama', model: 'glm-5.1:cloud', numCtx: 16384 }),
      { ollama: { think: false } },
    );
  });
  await test('deepseek: reasoning:false (or forceNoThink) DISABLES thinking', () => {
    assert.deepEqual(providerOptions({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: false }), { deepseek: { thinking: { type: 'disabled' } } });
    assert.deepEqual(providerOptions({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: true }), { deepseek: { thinking: { type: 'enabled' } } });
    assert.deepEqual(providerOptions({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: true }, { forceNoThink: true }), { deepseek: { thinking: { type: 'disabled' } } });
  });
  await test('anthropic: adaptive only when reasoning on AND not forced-tool', () => {
    assert.deepEqual(providerOptions({ provider: 'anthropic', model: 'claude-haiku-4.5', reasoning: true }), { anthropic: { thinking: { type: 'adaptive' } } });
    assert.deepEqual(providerOptions({ provider: 'anthropic', model: 'claude-haiku-4.5', reasoning: true }, { forceNoThink: true }), {});
    assert.deepEqual(providerOptions({ provider: 'anthropic', model: 'claude-haiku-4.5', reasoning: false }), {});
  });
  await test('google: gemini-3 → thinkingLevel:minimal, 2.5 → thinkingBudget:0 (reasoning off)', () => {
    assert.deepEqual(providerOptions({ provider: 'google', model: 'gemini-3.5-flash', reasoning: false }), { google: { thinkingConfig: { thinkingLevel: 'minimal' } } });
    assert.deepEqual(providerOptions({ provider: 'google', model: 'gemini-2.5-flash', reasoning: false }), { google: { thinkingConfig: { thinkingBudget: 0 } } });
    assert.deepEqual(providerOptions({ provider: 'google', model: 'gemini-3.5-flash', reasoning: true }), {});
  });
  await test('openai: reasoningEffort only on o-series/gpt-5', () => {
    assert.deepEqual(providerOptions({ provider: 'openai', model: 'o3', reasoning: false }), { openai: { reasoningEffort: 'minimal' } });
    assert.deepEqual(providerOptions({ provider: 'openai', model: 'o3', reasoning: true }), { openai: { reasoningEffort: 'medium' } });
    assert.deepEqual(providerOptions({ provider: 'openai', model: 'gpt-4.1-mini', reasoning: false }), {});
  });
  await test('openai-compatible: no providerOptions block (transport handles thinking)', () => {
    assert.deepEqual(providerOptions({ provider: 'openai-compatible', model: 'qwen3', reasoning: false }), {});
  });
  await test('locca: shares the openai-compatible path — no providerOptions block', () => {
    assert.deepEqual(providerOptions({ provider: 'locca', model: 'qwen3', reasoning: false }), {});
    assert.deepEqual(providerOptions({ provider: 'locca', model: 'qwen3', reasoning: true }), {});
  });
  await test('capability flags: tool-object covers ollama + locca + openai-compatible; repeat-penalty is Ollama-only', () => {
    assert.equal(needsToolCallObject({ provider: 'ollama' }), true);
    assert.equal(needsToolCallObject({ provider: 'openai' }), false);
    // locca + openai-compatible serve local GGUF models that don't explore under
    // native Output.object (explored=false on gemma-4-12b / qwen3.5-9b) — same as ollama.
    assert.equal(needsToolCallObject({ provider: 'locca' }), true);
    assert.equal(needsToolCallObject({ provider: 'openai-compatible' }), true);
    assert.equal(repeatPenaltyApplies({ provider: 'ollama' }), true);
    assert.equal(repeatPenaltyApplies({ provider: 'deepseek' }), false);
    assert.equal(repeatPenaltyApplies({ provider: 'locca' }), false);
    assert.equal(appliedNumCtx({ provider: 'ollama', model: 'qwen3', numCtx: 8192 }), 8192);
    assert.equal(appliedNumCtx({ provider: 'openai', model: 'gpt-4.1-mini', numCtx: 8192 }), null);
    assert.equal(appliedNumCtx({ provider: 'locca', model: 'qwen3', numCtx: 8192 }), null);
  });
  await test('appliedRepeatPenalty: body-injection providers only, and only when > 1.0', () => {
    // openai-compatible + locca inject via the request body (the openai
    // provider can't carry repeat_penalty in providerOptions).
    assert.equal(appliedRepeatPenalty({ provider: 'openai-compatible', repeatPenalty: 1.15 }), 1.15);
    assert.equal(appliedRepeatPenalty({ provider: 'locca', repeatPenalty: 1.25 }), 1.25);
    // 1.0 (or below) is a no-op — never injected.
    assert.equal(appliedRepeatPenalty({ provider: 'openai-compatible', repeatPenalty: 1.0 }), null);
    // Ollama reads its own value via providerOptions.ollama.options — not here
    // (no double-write into the sampling record).
    assert.equal(appliedRepeatPenalty({ provider: 'ollama', repeatPenalty: 1.2 }), null);
    // Cloud providers never inject.
    assert.equal(appliedRepeatPenalty({ provider: 'openai', repeatPenalty: 1.2 }), null);
    // Missing / junk value → null, no throw.
    assert.equal(appliedRepeatPenalty({ provider: 'openai-compatible' }), null);
  });

  console.log('openAICompatibleFetch (body no-think injection for self-hosted llama.cpp/locca):');
  await test('reasoning ON + forceNoThink OFF: thinking left ON (free-text DJ path keeps reasoning)', async () => {
    let sent: any = null;
    const impl = openAICompatibleFetch({ provider: 'locca', reasoning: true }, async (_u: any, init: any) => { sent = JSON.parse(init.body); return {} as any; }, false);
    await impl('http://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(sent.chat_template_kwargs?.enable_thinking, undefined);
    assert.equal(sent.reasoning_format, undefined);
  });
  await test('reasoning ON + forceNoThink ON: thinking SUPPRESSED (the picker legs — issue: schema-fail-on-picks)', async () => {
    let sent: any = null;
    const impl = openAICompatibleFetch({ provider: 'locca', reasoning: true }, async (_u: any, init: any) => { sent = JSON.parse(init.body); return {} as any; }, true);
    await impl('http://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(sent.chat_template_kwargs.enable_thinking, false);
    assert.equal(sent.reasoning_format, 'deepseek');
  });
  await test('reasoning OFF: thinking suppressed regardless of forceNoThink (existing behaviour preserved)', async () => {
    let sent: any = null;
    const impl = openAICompatibleFetch({ provider: 'openai-compatible', reasoning: false }, async (_u: any, init: any) => { sent = JSON.parse(init.body); return {} as any; }, false);
    await impl('http://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(sent.chat_template_kwargs.enable_thinking, false);
    assert.equal(sent.reasoning_format, 'deepseek');
  });

  await test('forcedToolChoice: only the literal "auto" downgrades; everything else is "required" (issue #570)', () => {
    // Opt-in downgrade for crash-prone forced-tool servers (newer Intel vLLM).
    assert.equal(forcedToolChoice({ provider: 'openai-compatible', toolChoice: 'auto' }), 'auto');
    // Default + explicit 'required' both force the tool call.
    assert.equal(forcedToolChoice({ provider: 'openai-compatible', toolChoice: 'required' }), 'required');
    assert.equal(forcedToolChoice({ provider: 'openai-compatible' }), 'required');
    // Provider-agnostic: it's a per-leg knob, not a per-provider trait.
    assert.equal(forcedToolChoice({ provider: 'ollama', toolChoice: 'auto' }), 'auto');
    assert.equal(forcedToolChoice({ provider: 'anthropic' }), 'required');
    // Garbage / missing cfg never accidentally weakens the default.
    assert.equal(forcedToolChoice({ toolChoice: 'whatever' }), 'required');
    assert.equal(forcedToolChoice(undefined), 'required');
  });

  // ---- embedding base URL (the relative-/embeddings crash, #405 follow-up) ----
  console.log('embeddingBaseUrl(cfg):');
  await test('locca blank → dedicated EMBED default, never chat or a relative URL', () => {
    // Blank locca baseUrl must resolve to the dedicated embed server (8090), NOT
    // the chat default (8080) and NOT '' (which would make the SDK fetch
    // "/embeddings" → "Failed to parse URL"). This is what makes locca a
    // first-class embedding provider with no hand-typed URL.
    assert.equal(embeddingBaseUrl({ provider: 'locca', baseUrl: '' }), DEFAULT_LOCCA_EMBED_BASE_URL);
    assert.match(DEFAULT_LOCCA_EMBED_BASE_URL, /:8090\/v1$/);
    assert.equal(embeddingBaseUrl({ provider: 'locca', baseUrl: 'http://x:9000/v1' }), 'http://x:9000/v1');
    // openai-compatible has no sane default — blank stays '' so the builder errors.
    assert.equal(embeddingBaseUrl({ provider: 'openai-compatible', baseUrl: '' }), '');
    assert.equal(embeddingBaseUrl({ provider: 'openai-compatible', baseUrl: 'http://y:8090/v1' }), 'http://y:8090/v1');
  });

  // ---- agent plan routing ----
  console.log('agentPlan(cfg, schema, toolCount):');
  await test('routes each provider/shape to the right plan', () => {
    assert.equal(agentPlan({ provider: 'ollama' }, {}, 0), 'object-via-tool');
    assert.equal(agentPlan({ provider: 'ollama' }, {}, 3), 'done-tool');
    assert.equal(agentPlan({ provider: 'openai' }, {}, 0), 'native-no-tools');
    assert.equal(agentPlan({ provider: 'openai' }, {}, 3), 'native-then-done');
    // locca + openai-compatible serve local GGUF models (same class as Ollama), so
    // they take the forced tool-object / done-tool path, NOT the native path — local
    // llama.cpp models emit the object without exploring tools under native Output.object.
    assert.equal(agentPlan({ provider: 'locca' }, {}, 0), 'object-via-tool');
    assert.equal(agentPlan({ provider: 'locca' }, {}, 3), 'done-tool');
    assert.equal(agentPlan({ provider: 'openai-compatible' }, {}, 0), 'object-via-tool');
    assert.equal(agentPlan({ provider: 'openai-compatible' }, {}, 3), 'done-tool');
    assert.equal(agentPlan({ provider: 'openai' }, null, 3), 'free-text');
    assert.equal(agentPlan({ provider: 'ollama' }, null, 0), 'free-text');
  });

  // ---- JSON / thinking salvage ----
  console.log('stripThinking / extractJson / usageOf:');
  await test('stripThinking removes complete and dangling <think> blocks', () => {
    assert.equal(stripThinking('<think>reasoning</think>hello'), 'hello');
    assert.equal(stripThinking('leftover reasoning</think>  the answer'), 'the answer');
    assert.equal(stripThinking('plain text'), 'plain text');
  });
  await test('stripThinking collapses a </think>-separated repetition loop to the first answer', () => {
    // Live incident 2026-07-07: glm-5.2:cloud looped the sign-off, emitting
    // </think> between each repeat until the token cap truncated the tail.
    const runaway =
      'Alright, I\'m out — good hands, see you tomorrow.</think>' +
      'Alright, I\'m clocking out — good hands, see you tomorrow.</think>' +
      'Alright, I\'m clocking out — good hands, see you tomorrow.</think>' +
      'Alright, I\'m clocking out before I talk myself into a';
    assert.equal(stripThinking(runaway), 'Alright, I\'m out — good hands, see you tomorrow.');
    // Never leak a stray tag even when nothing else matches.
    assert.equal(stripThinking('done for the night</think>'), 'done for the night');
    // A verbatim two-way repeat (no third segment) is still a loop, not a leak.
    assert.equal(stripThinking('same line here</think>same line here'), 'same line here');
  });
  await test('stripThinking drops an unterminated <think> block (token-cap truncation)', () => {
    // Issue #947: a reasoning model looped inside its <think> block until the
    // output-token cap cut it off, so the closing </think> never arrived. The
    // whole body is trapped reasoning — drop it rather than speak it aloud.
    assert.equal(
      stripThinking('<think>We need to output spoken words only. Must not use articles. Also no his. Also no her. Also'),
      '',
    );
    // Anything before the opener is real answer text — keep it (mirrors the
    // harmony no-final-channel rule below).
    assert.equal(stripThinking('Here we go. <think>wait, should I mention the'), 'Here we go.');
  });
  await test('stripThinking strips Gemma/harmony channel reasoning, keeps the final message', () => {
    // thought → final: keep only the final channel's message
    assert.equal(
      stripThinking('<|channel|>thought<|message|>let me think…<|channel|>final<|message|>Coming up next: a classic.'),
      'Coming up next: a classic.',
    );
    // token variant without the trailing pipe (<|channel>thought)
    assert.equal(
      stripThinking('<|channel>analysis<|message>deliberating<|channel>final<|message>Here we go.'),
      'Here we go.',
    );
    // no final channel — the answer is trapped in the thought channel; strip to
    // empty rather than speak the deliberation aloud
    assert.equal(stripThinking('<|channel|>thought<|message|>hmm, still thinking'), '');
    // plain text with no channel tokens is untouched
    assert.equal(stripThinking('Just a normal DJ line.'), 'Just a normal DJ line.');
  });
  await test('extractJson pulls the object out of fences and prose', () => {
    assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(extractJson('here you go: {"a":1,"b":2} done'), '{"a":1,"b":2}');
    assert.throws(() => extractJson('no json here'));
    assert.throws(() => extractJson(''));
  });
  await test('usageOf normalises totalUsage / usage / missing', () => {
    assert.deepEqual(usageOf({ totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }), { input: 10, output: 5, total: 15 });
    assert.deepEqual(usageOf({ usage: { promptTokens: 3, completionTokens: 2 } }), { input: 3, output: 2, total: 5 });
    assert.deepEqual(usageOf({}), { input: 0, output: 0, total: 0 });
  });

  // ---- daily token budget mode ----
  console.log('budgetMode (daily LLM token cap → normal/soft/hard):');
  await test('cap <= 0 (or non-finite) is always normal — the disabled default', () => {
    assert.equal(budgetMode({ used: 9_999_999, cap: 0, softPct: 80 }), 'normal');
    assert.equal(budgetMode({ used: 1, cap: -5, softPct: 80 }), 'normal');
    assert.equal(budgetMode({ used: 1, cap: NaN, softPct: 80 }), 'normal');
  });
  await test('used below soft threshold is normal', () => {
    assert.equal(budgetMode({ used: 700, cap: 1000, softPct: 80 }), 'normal');
  });
  await test('used at/above soft threshold but below cap is soft', () => {
    assert.equal(budgetMode({ used: 800, cap: 1000, softPct: 80 }), 'soft');
    assert.equal(budgetMode({ used: 999, cap: 1000, softPct: 80 }), 'soft');
  });
  await test('used at/above cap is hard', () => {
    assert.equal(budgetMode({ used: 1000, cap: 1000, softPct: 80 }), 'hard');
    assert.equal(budgetMode({ used: 5000, cap: 1000, softPct: 80 }), 'hard');
  });
  await test('softPct 0 or 100 disables the soft tier (straight to hard at cap)', () => {
    assert.equal(budgetMode({ used: 999, cap: 1000, softPct: 0 }), 'normal');
    assert.equal(budgetMode({ used: 999, cap: 1000, softPct: 100 }), 'normal');
    assert.equal(budgetMode({ used: 1000, cap: 1000, softPct: 0 }), 'hard');
  });

  // ---- talk-within-the-intro budget ----
  console.log('introBudgetPhrase / enforceIntroBudget:');
  await test('introBudgetPhrase is empty outside the usable runway window', () => {
    assert.equal(introBudgetPhrase(null), '');
    assert.equal(introBudgetPhrase(1000), '');
    assert.equal(introBudgetPhrase(20000), '');
    assert.match(introBudgetPhrase(4000), /4s/);
    assert.match(introBudgetPhrase(10000), /10s/);
  });
  await test('enforceIntroBudget trims to a budget, prefers sentence boundary', () => {
    assert.equal(enforceIntroBudget('Short line.', 5000), 'Short line.');           // under budget
    assert.equal(enforceIntroBudget('text', null), 'text');                          // no runway
    assert.equal(enforceIntroBudget('text', 20000), 'text');                         // ≥18s
    const sentences = enforceIntroBudget('One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve.', 4000);
    assert.ok(sentences.endsWith('.') && sentences.split(/\s+/).length <= 10);        // last full sentence
    const hardcut = enforceIntroBudget('a b c d e f g h i j k l m n o p q r s t', 4000);
    assert.ok(hardcut.endsWith('…') && hardcut.split(/\s+/).length <= 11);            // ellipsis fallback
  });

  // ---- persona tone dials (humour / local colour / warmth) ----
  console.log('personaToneDirectives / normalizeDial:');
  await test('normalizeDial clamps to 0-10 int, neutral on garbage', () => {
    assert.equal(normalizeDial(7), 7);
    assert.equal(normalizeDial(-3), 0);
    assert.equal(normalizeDial(99), 10);
    assert.equal(normalizeDial(6.7), 7);
    assert.equal(normalizeDial('abc'), DIAL_NEUTRAL);
    assert.equal(normalizeDial(undefined), DIAL_NEUTRAL);
  });
  await test('neutral / missing dials append nothing (prompt stays byte-identical)', () => {
    assert.equal(personaToneDirectives({ humour: 5, localColour: 5, warmth: 5 }), '');
    assert.equal(personaToneDirectives({}), '');
    assert.equal(personaToneDirectives(null), '');
    assert.equal(personaToneDirectives({ humour: 4, localColour: 6 }), '');
  });
  await test('low/high bands append the matching directive, in dial order', () => {
    assert.match(personaToneDirectives({ humour: 9 }), /playful wit/);
    assert.match(personaToneDirectives({ humour: 1 }), /Play it straight/);
    assert.match(personaToneDirectives({ localColour: 10 }), /local setting/);
    assert.match(personaToneDirectives({ warmth: 0 }), /cool, dry distance/);
    const both = personaToneDirectives({ humour: 8, warmth: 8 });
    assert.ok(both.startsWith('\n\nTone:\n- '));
    assert.equal(both.split('\n- ').length, 3); // header + 2 bullets
  });
  // The save path (validatePersonasStrict) rebuilds each persona from a field
  // whitelist; if the dials aren't in it they are silently dropped on every
  // save and the feature is dead end-to-end. Pin that they round-trip.
  await test('validatePersonasStrict carries the dials through the save path', () => {
    const base = { name: 'Nova', soul: 'late-night', frequency: 'moderate',
      tts: { engine: 'piper', cloudProvider: 'openai', voice: '' } };
    const [saved] = validatePersonasStrict([{ ...base, humour: 9, localColour: 0, warmth: 99 }]);
    assert.equal(saved.humour, 9);
    assert.equal(saved.localColour, 0);
    assert.equal(saved.warmth, 10);            // clamped, same as normalizeDial
    const [bare] = validatePersonasStrict([base]);
    assert.equal(bare.humour, DIAL_NEUTRAL);   // absent dials default to neutral
    assert.equal(bare.localColour, DIAL_NEUTRAL);
    assert.equal(bare.warmth, DIAL_NEUTRAL);
  });

  // ---- the 5-rung frequency ladder + 4-rung script-length ladder ----
  // Every consumer (dj-gate slots, segment floors, link spacing, run
  // probability, LENGTH_PHRASES) branches on these values; pin the ladder
  // mechanics and the save path so a rung can't silently vanish.
  console.log('effectiveFrequency / lengthMode (behaviour ladders):');
  await test('djMode bumps exactly one rung, capped at aggressive', () => {
    const p = (frequency: string, djMode = true) => ({ frequency, djMode });
    assert.equal(effectiveFrequency(p('quiet')), 'moderate');
    assert.equal(effectiveFrequency(p('moderate')), 'chatty');
    assert.equal(effectiveFrequency(p('chatty')), 'aggressive');
    assert.equal(effectiveFrequency(p('aggressive')), 'aggressive');
    assert.equal(effectiveFrequency(p('chatty', false)), 'chatty');
  });
  await test('silent is absolute — djMode never bumps out of it', () => {
    assert.equal(effectiveFrequency({ frequency: 'silent', djMode: true }), 'silent');
    assert.equal(effectiveFrequency({ frequency: 'silent', djMode: false }), 'silent');
  });
  await test('unknown / missing frequency falls back to moderate', () => {
    assert.equal(effectiveFrequency({ frequency: 'shouty' }), 'moderate');
    assert.equal(effectiveFrequency({}), 'moderate');
  });
  await test('validatePersonasStrict round-trips the new rungs', () => {
    const base = { name: 'Nova', soul: 'late-night',
      tts: { engine: 'piper', cloudProvider: 'openai', voice: '' } };
    const [saved] = validatePersonasStrict([{ ...base, frequency: 'silent', scriptLength: 'storyteller' }]);
    assert.equal(saved.frequency, 'silent');
    assert.equal(saved.scriptLength, 'storyteller');
    assert.throws(() => validatePersonasStrict([{ ...base, frequency: 'shouty' }]), /frequency/);
    assert.throws(() => validatePersonasStrict([{ ...base, frequency: 'quiet', scriptLength: 'epic' }]), /scriptLength/);
  });
  await test('lengthMode maps every rung to itself, junk to concise', () => {
    for (const l of SCRIPT_LENGTHS) assert.equal(lengthMode({ scriptLength: l }), l);
    assert.equal(lengthMode({ scriptLength: 'epic' }), 'concise');
    assert.equal(lengthMode({}), 'concise');
    // Object.hasOwn guard: a prototype key must not select a phrase table.
    assert.equal(lengthMode({ scriptLength: 'toString' }), 'concise');
  });
  await test('every rung has a phrase for every segment kind', () => {
    for (const l of SCRIPT_LENGTHS) {
      for (const kind of ['intro', 'link', 'stationId', 'hourly', 'adlib', 'segment']) {
        const phrase = lengthPhrase(kind, { scriptLength: l });
        assert.ok(typeof phrase === 'string' && phrase.length > 0, `${l}/${kind} empty`);
      }
    }
  });

  // ---- clampTtsSpeed: per-engine / per-persona speech-rate multiplier ----
  // Defaults to 1.0 (NOT 0 like gain) so a stock station — and any older save
  // with no tts.speed — composes to unity and is byte-for-byte unchanged.
  console.log('clampTtsSpeed (speech-rate multiplier, default 1.0):');
  await test('non-finite / missing → 1.0 (unity)', () => {
    assert.equal(clampTtsSpeed(undefined), TTS_SPEED_DEFAULT);
    assert.equal(clampTtsSpeed(null), 1.0);
    assert.equal(clampTtsSpeed('abc'), 1.0);
    assert.equal(clampTtsSpeed(NaN), 1.0);
  });
  await test('clamps to [0.5, 2.0]', () => {
    assert.equal(clampTtsSpeed(0.1), 0.5);
    assert.equal(clampTtsSpeed(-3), 0.5);
    assert.equal(clampTtsSpeed(5), 2.0);
    assert.equal(clampTtsSpeed(2.0), 2.0);
    assert.equal(clampTtsSpeed(0.5), 0.5);
  });
  await test('rounds to 0.05 step', () => {
    assert.equal(clampTtsSpeed(1.23), 1.25);
    assert.equal(clampTtsSpeed(0.87), 0.85);
    assert.equal(clampTtsSpeed(1.0), 1.0);
  });

  // The persona save path (validatePersonasStrict → validateTtsBlock) must carry
  // tts.speed through, else the per-persona dial is silently dropped on every save.
  await test('validatePersonasStrict carries tts.speed through the save path', () => {
    const base = { name: 'Nova', soul: 'late-night', frequency: 'moderate',
      tts: { engine: 'piper', cloudProvider: 'openai', voice: '' } };
    const [fast] = validatePersonasStrict([{ ...base, tts: { ...base.tts, speed: 1.4 } }]);
    assert.equal(fast.tts.speed, 1.4);
    const [clamped] = validatePersonasStrict([{ ...base, tts: { ...base.tts, speed: 9 } }]);
    assert.equal(clamped.tts.speed, 2.0);          // clamped to max
    const [bare] = validatePersonasStrict([base]);
    assert.equal(bare.tts.speed, TTS_SPEED_DEFAULT); // absent → unity
  });

  // ---- showMusicLean: soft lean vs strict genre lock (shared by both pick paths) ----
  console.log('showMusicLean (soft lean vs strict genre lock):');
  const SOFT_GENRE_LINE = '\n\nMusic steer for this show — lean toward Jazz. These are preferences, not hard filters: break them only when the flow genuinely demands it.';
  await test('no show → empty string', () => {
    assert.equal(showMusicLean(null), '');
    assert.equal(showMusicLean(undefined), '');
  });
  await test('soft genre-only show is byte-for-byte the legacy line', () => {
    assert.equal(showMusicLean({ name: 'x', topic: 'y', genre: 'Jazz' }), SOFT_GENRE_LINE);
  });
  await test('filtersStrict=false leaves the soft path unchanged', () => {
    assert.equal(showMusicLean({ name: 'x', topic: 'y', genre: 'Jazz', filtersStrict: false }), SOFT_GENRE_LINE);
  });
  await test('strict filters are a hard rule, not a soft lean', () => {
    const out = showMusicLean({ name: 'x', topic: 'y', genre: 'Hip-Hop', filtersStrict: true });
    assert.match(out, /music filters are STRICT/);                  // the unified strict lock (#766)
    assert.match(out, /Hip-Hop tracks/);                            // genre carried into the lock
    assert.match(out, /Keep your talk inside them too/);            // stay-in-filter instruction
    assert.match(out, /only step outside if there is genuinely nothing left that fits/); // hard rule + escape hatch
    assert.doesNotMatch(out, /lean toward Hip-Hop/);
    assert.doesNotMatch(out, /Music steer/);     // no soft line when strict is on
  });
  await test('strict carries the never-starve escape hatch', () => {
    const out = showMusicLean({ name: 'x', topic: 'y', genre: 'Metal', filtersStrict: true });
    assert.match(out, /never leave dead air/i);   // can stray only to avoid dead air
  });
  await test('strict needs a filter — filtersStrict alone is inert', () => {
    assert.equal(showMusicLean({ name: 'x', topic: 'y', filtersStrict: true }), '');
    // energy alone still bites: the unified toggle locks any pinned filter, not just genre
    const out = showMusicLean({ name: 'x', topic: 'y', energy: 'high', filtersStrict: true });
    assert.match(out, /music filters are STRICT/);
    assert.match(out, /high-energy tracks/);
    assert.doesNotMatch(out, /Music steer/);   // strict, so no soft line
  });
  await test('strict locks genre, era and energy together (unified toggle)', () => {
    const out = showMusicLean({ name: 'x', topic: 'y', genre: 'Soul', filtersStrict: true, fromYear: 1970, toYear: 1979, energy: 'medium' });
    assert.match(out, /music filters are STRICT/);   // unified strict lock (#766)
    assert.match(out, /Soul tracks/);
    assert.match(out, /the 1970–1979 era/);
    assert.match(out, /medium-energy tracks/);
    assert.doesNotMatch(out, /Music steer/);       // era/energy are strict too — no soft line
    assert.doesNotMatch(out, /lean toward Soul/);  // genre is part of the hard lock
  });

  // ---- clampMaxOutputTokens / resolveMaxOutputTokens (per-call cap, #712) ----
  console.log('clampMaxOutputTokens / resolveMaxOutputTokens (per-call output cap):');
  await test('0 and negatives mean "off" — pass through as 0, not the floor', () => {
    assert.equal(clampMaxOutputTokens(0, 4000), 0);
    assert.equal(clampMaxOutputTokens(-5, 4000), 0);
  });
  await test('non-numeric / NaN falls back to def (leaves the stored value untouched)', () => {
    assert.equal(clampMaxOutputTokens('nope', 4000), 4000);
    assert.equal(clampMaxOutputTokens(NaN, 8000), 8000);
    assert.equal(clampMaxOutputTokens(undefined, 1234), 1234);
    assert.equal(clampMaxOutputTokens(Infinity, 4000), 4000);
  });
  await test('1..499 rounds up to the 500 floor; over-max clamps to 8000', () => {
    assert.equal(clampMaxOutputTokens(1, 4000), MAX_OUTPUT_TOKENS_MIN);
    assert.equal(clampMaxOutputTokens(499, 4000), 500);
    assert.equal(clampMaxOutputTokens(9000, 4000), MAX_OUTPUT_TOKENS_MAX);
  });
  await test('in-range values pass through, floored to an int', () => {
    assert.equal(clampMaxOutputTokens(500, 4000), 500);
    assert.equal(clampMaxOutputTokens(2000, 4000), 2000);
    assert.equal(clampMaxOutputTokens(8000, 4000), 8000);
    assert.equal(clampMaxOutputTokens(2000.9, 4000), 2000);
  });
  await test('resolveMaxOutputTokens returns the strategy fallback when unset (default 0)', () => {
    // No update() has run in this pure harness, so settings.get() is DEFAULTS
    // (maxOutputTokens: 0) → each strategy keeps its own built-in default.
    assert.equal(resolveMaxOutputTokens(4000), 4000);
    assert.equal(resolveMaxOutputTokens(8000), 8000);
  });

  // ---- nearestId: near-miss id repair for the picker agents ----
  console.log('nearestId (unknown-id near-miss repair):');
  await test('repairs the observed live case: final character dropped from a nanoid', () => {
    // glm-5.1 returned "BFjCKvSeWFKFpKTRvroPC" for the real "BFjCKvSeWFKFpKTRvroPCp".
    const seen = ['2igTN1Xw3uJBY9CjdKzZGl', 'H8G6Y1gPsSsMNJwflWbstW', 'BFjCKvSeWFKFpKTRvroPCp'];
    assert.equal(nearestId('BFjCKvSeWFKFpKTRvroPC', seen), 'BFjCKvSeWFKFpKTRvroPCp');
  });
  await test('repairs a single substituted character (edit distance 1)', () => {
    const seen = ['yu4ZsUclpGxnr8CU2YfNf7', 'qJcxd61T5W7YJ0bNryKakG'];
    assert.equal(nearestId('yu4ZsUclpGxnr8CU2YfNf8', seen), 'yu4ZsUclpGxnr8CU2YfNf7');
  });
  await test('rejects a fabricated id (nothing near any candidate)', () => {
    const seen = ['2igTN1Xw3uJBY9CjdKzZGl', 'H8G6Y1gPsSsMNJwflWbstW'];
    assert.equal(nearestId('3bKpTnYlqR8vD4sXe2aJ0m', seen), null);
  });
  await test('rejects an ambiguous match (two candidates equally close)', () => {
    // Both differ from the query by one trailing character — no safe winner.
    const seen = ['AAAAAAAAAAAAAAAAAAAAAx', 'AAAAAAAAAAAAAAAAAAAAAy'];
    assert.equal(nearestId('AAAAAAAAAAAAAAAAAAAAAz', seen), null);
  });
  await test('rejects short-prefix matches (below the 12-char floor)', () => {
    assert.equal(nearestId('abc', ['abcdef123456789012345']), null);
  });
  await test('handles junk input without throwing', () => {
    assert.equal(nearestId('', ['abcdef123456789012345']), null);
    assert.equal(nearestId(undefined as any, ['abcdef123456789012345']), null);
    assert.equal(nearestId('abcdef123456789012345', []), null);
  });

  // ---- resolveCloudModel: cloud TTS model resolution for the v3 tag hint ----
  // Pins the "mirror of speak() + resolveEngine()" claim (issue #696): the
  // model djSystem gates the ElevenLabs v3 hint on must be the one the persona
  // is actually voiced by at speak() time.
  console.log('resolveCloudModel (ElevenLabs v3 hint gating, issue #696):');
  const cloudCfg = { defaultEngine: 'piper', provider: 'elevenlabs', model: 'eleven_v3' };
  await test('explicit cloud persona with no provider override → global model', () => {
    assert.equal(resolveCloudModel({ engine: 'cloud' }, cloudCfg), 'eleven_v3');
  });
  await test('provider override away from global → new provider default, NOT the global model', () => {
    // Persona on ElevenLabs while the global cloud provider is OpenAI is
    // voiced by eleven_flash_v2_5 — gating on the provider alone would hint a
    // v2 voice that reads the brackets aloud.
    assert.equal(
      resolveCloudModel({ engine: 'cloud', cloudProvider: 'elevenlabs' }, { defaultEngine: 'piper', provider: 'openai', model: 'gpt-4o-mini-tts' }),
      'eleven_flash_v2_5',
    );
  });
  await test('provider override matching the global provider → global model', () => {
    assert.equal(resolveCloudModel({ engine: 'cloud', cloudProvider: 'elevenlabs' }, cloudCfg), 'eleven_v3');
  });
  await test('override to openai-compatible (no per-provider default) keeps the global model', () => {
    assert.equal(
      resolveCloudModel({ engine: 'cloud', cloudProvider: 'openai-compatible' }, cloudCfg),
      'eleven_v3',
    );
  });
  await test('persona with no engine rides the station defaultEngine: cloud', () => {
    // The common setup: global defaultEngine cloud + untouched personas — a
    // persona-engine check would miss this and the hint would never fire.
    assert.equal(
      resolveCloudModel({}, { defaultEngine: 'cloud', provider: 'elevenlabs', model: 'eleven_v3' }),
      'eleven_v3',
    );
    assert.equal(
      resolveCloudModel(null, { defaultEngine: 'cloud', provider: 'elevenlabs', model: 'eleven_v3' }),
      'eleven_v3',
    );
  });
  await test('persona on a local engine → no model, regardless of defaultEngine', () => {
    assert.equal(resolveCloudModel({ engine: 'piper' }, { defaultEngine: 'cloud', provider: 'elevenlabs', model: 'eleven_v3' }), '');
    assert.equal(resolveCloudModel({ engine: 'chatterbox' }, { defaultEngine: 'cloud', provider: 'elevenlabs', model: 'eleven_v3' }), '');
  });
  await test('no engine anywhere near cloud → no model', () => {
    assert.equal(resolveCloudModel({}, cloudCfg), '');
    assert.equal(resolveCloudModel({ engine: '' }, cloudCfg), '');
  });
  await test('unknown persona engine string fails closed (no hint beats a spoken bracket)', () => {
    assert.equal(resolveCloudModel({ engine: 'bogus' }, { defaultEngine: 'cloud', provider: 'elevenlabs', model: 'eleven_v3' }), '');
  });

  console.log('isElevenLabsV3 (model-family gate):');
  await test('matches the v3 family, case- and separator-insensitive', () => {
    assert.equal(isElevenLabsV3('eleven_v3'), true);
    assert.equal(isElevenLabsV3('ELEVEN_V3'), true);
    assert.equal(isElevenLabsV3('eleven-v3'), true);
    assert.equal(isElevenLabsV3('eleven_v3_preview'), true);
  });
  await test('rejects v2 families, non-TTS v3 ids, and junk', () => {
    assert.equal(isElevenLabsV3('eleven_flash_v2_5'), false);
    assert.equal(isElevenLabsV3('eleven_multilingual_v2'), false);
    assert.equal(isElevenLabsV3('eleven_ttv_v3'), false);
    assert.equal(isElevenLabsV3('gpt-4o-mini-tts'), false);
    assert.equal(isElevenLabsV3(''), false);
  });

  console.log(failures === 0 ? '\nAll llm-pure tests passed.' : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main();
