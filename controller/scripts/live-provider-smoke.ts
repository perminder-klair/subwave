// Opt-in, billable provider checks. Never discovered by npm test.
// node --import tsx scripts/live-provider-smoke.ts --env-dir /path/to/reference
//   --models openrouter:google/gemini-2.5-flash,google:gemini-2.5-flash
//   --out /tmp/provider-results.json
// openai-compatible requires --base-url and OPENAI_COMPATIBLE_API_KEY.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { embed, streamText } from 'ai';
import { z } from 'zod';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const modelSpecs = option('--models')?.split(',').filter(Boolean) ?? [];
if (!modelSpecs.length || !option('--out')) {
  throw new Error('Specify --models provider:model,... and --out /path/to/report.json');
}
const reportPath = z.string().min(1).parse(option('--out'));
const compatibleMode = z.enum(['hosted', 'local']).parse(option('--compatible-mode') ?? 'hosted');
const credentialNames = [
  'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY',
  'AI_GATEWAY_API_KEY', 'REQUESTY_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
];
const reference = option('--env-dir');
if (reference) {
  for (const relative of ['.env', 'controller/.env']) {
    const file = await readFile(path.join(reference, relative), 'utf8').catch(() => '');
    const values = parse(file);
    for (const name of credentialNames) {
      if (!process.env[name] && values[name]) process.env[name] = values[name];
    }
  }
}

// Set this before importing application modules: config captures state at boot.
const stateDir = await mkdtemp(path.join(tmpdir(), 'subwave-live-smoke-'));
process.env.STATE_DIR = stateDir;
process.env.LLM_DEBUG_RAW = '0';
const settings = await import('../src/settings.js');
const store = await import('../src/settings/store.js');
const { djText, djObject, djAgent } = await import('../src/llm/sdk.js');
const { primaryLeg, buildEmbeddingModel } = await import('../src/llm/provider.js');
const { recentCalls } = await import('../src/llm/log.js');
const { speak } = await import('../src/llm/speech.js');
const defaults = settings.getDefaults();
type SmokeRecord = {
  target: string;
  check: string;
  outcome: 'passed' | 'failed' | 'skipped';
  ms: number;
  detail: unknown;
};
const records: SmokeRecord[] = [];
const secrets = credentialNames.map(name => process.env[name]).filter((value): value is string => !!value);
function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Non-Error rejection';
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  return message.slice(0, 600);
}
async function check(target: string, name: string, run: () => Promise<unknown>) {
  const started = Date.now();
  try {
    const detail = await run();
    records.push({ target, check: name, outcome: 'passed', ms: Date.now() - started, detail });
  } catch (error) {
    records.push({ target, check: name, outcome: 'failed', ms: Date.now() - started, detail: errorMessage(error) });
  }
  await writeFile(reportPath, JSON.stringify({ node: process.version, records }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(records.at(-1)));
}
function telemetry() {
  const call = recentCalls[0];
  return { via: call?.via, usage: call?.usage };
}
const outputSchema = z.object({ id: z.string(), reason: z.string() });
try {
  for (const spec of modelSpecs) {
    const split = spec.indexOf(':');
    assert.ok(split > 0, 'Models must be provider:model');
    const provider = spec.slice(0, split);
    const model = spec.slice(split + 1);
    store.setCache({ ...defaults, llm: {
      ...defaults.llm, provider, model, reasoning: false,
      ...(provider === 'openai-compatible' ? { baseUrl: option('--base-url') ?? '', compatibleMode } : {}),
      keys: { ...defaults.llm.keys, 'openai-compatible': process.env.OPENAI_COMPATIBLE_API_KEY ?? '' },
      fallback: { ...defaults.llm.fallback, enabled: false },
    } });
    await check(spec, 'djText', async () => {
      const text = await djText({
        system: 'Follow the user instruction exactly.', prompt: 'Reply with exactly SUBWAVE_OK.',
        maxOutputTokens: 512, signal: AbortSignal.timeout(45000), kind: 'liveSmoke.text',
      });
      assert.equal(text.trim(), 'SUBWAVE_OK');
      return telemetry();
    });
    await check(spec, 'djObject', async () => {
      const object = outputSchema.parse(await djObject({
        prompt: 'Return id live-track-001 and reason SDK verification.', schema: outputSchema,
        maxOutputTokens: 1024, signal: AbortSignal.timeout(45000), kind: 'liveSmoke.object',
      }));
      assert.equal(object.id, 'live-track-001');
      return telemetry();
    });
    await check(spec, 'djAgent discovery', async () => {
      let discoveries = 0;
      const candidateId = `live-${Math.random().toString(36).slice(2)}`;
      const result = await djAgent({
        system: 'You must call candidates to discover the available track before returning its exact id and a short reason. Never invent an id.',
        messages: [{ role: 'user', content: 'Select the track returned by candidates.' }],
        tools: { candidates: {
          description: 'Discover the one available track. Call before selecting.',
          inputSchema: z.object({}),
          execute: async () => { discoveries++; return [{ id: candidateId, title: 'Test signal' }]; },
        } },
        schema: outputSchema, maxOutputTokens: 2048, timeoutMs: 60000,
        providerDiscoveryBudget: true, kind: 'liveSmoke.agent',
      });
      const object = outputSchema.parse(result.object);
      assert.ok(discoveries > 0, 'Discovery tool must execute');
      assert.equal(object.id, candidateId);
      assert.ok(result.toolCalls.some(call => call.name === 'candidates'));
      return { ...telemetry(), discoveries, steps: result.steps };
    });
    await check(spec, 'streamText', async () => {
      let streamError: unknown;
      const result = streamText({
        model: primaryLeg().noThinkModel, prompt: 'Reply with exactly SUBWAVE_OK.',
        maxOutputTokens: 512, abortSignal: AbortSignal.timeout(45000),
        onError: ({ error }) => { streamError = error; },
      });
      let text = '';
      for await (const chunk of result.textStream) text += chunk;
      if (streamError) throw streamError;
      assert.equal(text.trim(), 'SUBWAVE_OK');
      return { usage: await result.totalUsage };
    });
    if (provider === 'google' || provider === 'openrouter') {
      await check(spec, 'embedding', async () => {
        const result = await embed({
          model: buildEmbeddingModel({
            provider, enabled: true, model: provider === 'google' ? 'gemini-embedding-001' : 'openai/text-embedding-3-small',
            apiKey: process.env[provider === 'google' ? 'GOOGLE_GENERATIVE_AI_API_KEY' : 'OPENROUTER_API_KEY'] ?? '',
            ollamaUrl: '', baseUrl: '',
          }),
          value: 'A warm instrumental radio track.', abortSignal: AbortSignal.timeout(45000),
        });
        assert.ok(result.embedding.length > 0);
        assert.ok(result.embedding.every(Number.isFinite));
        return { dimensions: result.embedding.length, usage: result.usage };
      });
    }
  }
  if (process.env.ELEVENLABS_API_KEY) {
    await check('elevenlabs:eleven_flash_v2_5', 'cloud speech', async () => {
      const file = await speak('Subwave provider verification.', {
        cloudOverride: { provider: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'JBFqnCBsd6RMkjVDRZzb' },
        outPath: path.join(stateDir, 'speech.mp3'), signal: AbortSignal.timeout(45000),
      });
      const bytes = await readFile(file);
      assert.ok(bytes.length > 1000);
      return { bytes: bytes.length };
    });
  }
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
if (records.some(record => record.outcome === 'failed')) process.exitCode = 1;
