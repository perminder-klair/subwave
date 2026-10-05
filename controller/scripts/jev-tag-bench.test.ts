import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { experimental_evaluate as evaluate } from 'ai';
import { parseSample, metadata, jevQuestions, decodeJev, summarize, jevProvider } from './jev-tag-bench.js';

const fixture = () => parseSample({
  moods: ['calm', 'energetic'],
  tracks: [{ id: 'a', title: 'A', artist: 'Artist', split: 'tune',
    expected: { moods: ['calm'], energy: 'low' } }, { id: 'b', title: 'B' }],
});

test('sample rejects ambiguous IDs and strips labels from model metadata', () => {
  assert.throws(() => parseSample({ tracks: [{ id: 'a' }, { id: 'a' }] }), /unique/);
  assert.throws(() => parseSample({ moods: ['calm', 'calm'], tracks: [{ id: 'a' }] }), /unique/);
  const sample = fixture();
  assert.deepEqual(Object.keys(metadata(sample.tracks[0])).sort(), ['album', 'artist', 'genres', 'title', 'year']);
  const questions = jevQuestions(sample.tracks, sample.moods!);
  assert.equal(Object.keys(questions).length, 6);
  assert.match(String(questions.t1_m0.instructions), /tracks\[1\]/);
  assert.match(String(questions.t1_m0.instructions), /calm/);
});

for (const route of ['typesafe', 'openrouter'] as const) test(`${route} adapter maps Boolean to Noul and retains rounded probabilities`, async () => {
  const sample = fixture();
  const provider = jevProvider(route, 'test-key', async (url, init) => {
    assert.equal(String(url), route === 'openrouter'
      ? 'https://openrouter.ai/api/alpha/decisions' : 'https://api.typesafe.ai/v1/systemone');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.questions.t0_m0.type, 'noul');
    assert.equal(payload.questions.t0_energy.type, 'choice');
    assert.equal(payload.state.tracks[0].expected, undefined);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
    return new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        t0_m0: { type: 'noul', noul: 0.85 },
        t0_m1: { type: 'noul', noul: 0.12 },
        t0_energy: { type: 'choice', choice: 'unknown', confidence: 0.63,
          probabilities: { low: 0.07, medium: 0.07, high: 0.07, unknown: 0.8 } },
      },
      usage: { input_tokens: 300, output_tokens: 10 },
    }), { headers: { 'content-type': 'application/json' } });
  });
  const result = await evaluate({
    model: provider.evaluationModel('jev-1.13.0'),
    state: { tracks: [metadata(sample.tracks[0])] },
    questions: jevQuestions(sample.tracks.slice(0, 1), sample.moods!), maxRetries: 0,
  });
  assert.equal(result.response.modelId, 'jev-1.13.0');
  assert.equal(result.usage.inputTokens, 300);
  assert.equal(result.providerMetadata?.typesafe?.confidence && typeof result.providerMetadata.typesafe.confidence, 'object');
  const [prediction] = decodeJev(result.answers, 1, sample.moods!, 0.75);
  assert.deepEqual(prediction.moods, ['calm']);
  assert.equal(prediction.energy, null);
  assert.equal(prediction.moodProbabilities?.calm, 0.85);
});

test('decoding permits abstention, caps moods, and rejects incomplete answers', () => {
  const moods = ['a', 'b', 'c', 'd'];
  const answers = {
    t0_m0: { type: 'boolean' as const, probability: 0.8 },
    t0_m1: { type: 'boolean' as const, probability: 0.9 },
    t0_m2: { type: 'boolean' as const, probability: 0.7 },
    t0_m3: { type: 'boolean' as const, probability: 1 },
    t0_energy: { type: 'choice' as const, choice: 'low' },
  };
  assert.deepEqual(decodeJev(answers, 1, moods, 0.7)[0].moods, ['d', 'b', 'a']);
  assert.deepEqual(decodeJev(answers, 1, ['a'], 0.95)[0].moods, []);
  assert.throws(() => decodeJev({}, 1, moods, 0.75), /Missing/);
  assert.throws(() => decodeJev({ ...answers, t0_m0: { type: 'boolean', probability: NaN } }, 1, moods, 0.75), /invalid/);
});

test('metrics distinguish missing labels, held-out labels, and batch errors', () => {
  const sample = fixture();
  const summary = summarize([
    { engine: 'jev', ids: ['a', 'b'], iteration: 1, ms: 100, outcome: 'ok', predictions: [
      { moods: ['calm'], energy: 'low', moodProbabilities: { calm: 0.8, energetic: 0.2 } },
      { moods: [], energy: null, moodProbabilities: { calm: 0.5, energetic: 0.5 } },
    ] },
    { engine: 'jev', ids: ['a', 'b'], iteration: 2, ms: 200, outcome: 'error' },
  ], sample.tracks, sample.moods!) as any;
  assert.equal(summary.jev.failedBatches, 1);
  assert.equal(summary.jev.successfulTrackEvaluations, 2);
  assert.equal(summary.jev.moodCoverage, 0.5);
  assert.equal(summary.jev.estimatedCostUsd, null);
  assert.equal(summary.jev.quality.tune.moodPrecision, 1);
  assert.ok(Math.abs(summary.jev.quality.tune.moodBrierScore - 0.04) < 1e-9);
  assert.equal(summary.jev.quality.eval.reviewedTrackEvaluations, 0);
  assert.equal(summary.jev.quality.eval.energyAccuracy, null);
});

test('dry-run isolates active station state, strips credentials, and refuses overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-bench-test-'));
  try {
    const root = join(dir, 'station');
    const active = join(root, 'stations', 'test');
    await mkdir(active, { recursive: true });
    // An explicit station leaf also works, without requiring an active pointer.
    const stored = JSON.stringify({ llm: { provider: 'ollama', model: 'test', keys: { openai: 'secret-marker' } } });
    await writeFile(join(active, 'settings.json'), stored);
    const input = join(dir, 'sample.json');
    await writeFile(input, JSON.stringify(fixture()));
    const out = join(dir, 'report');
    const script = fileURLToPath(new URL('./jev-tag-bench.ts', import.meta.url));
    const args = ['--import', 'tsx', script, '--input', input, '--state-dir', active, '--out', out, '--dry-run'];
    const run = await promisify(execFile)(process.execPath, args, { timeout: 60000 });
    assert.match(run.stdout, /Dry run/);
    assert.equal(await readFile(join(active, 'settings.json'), 'utf8'), stored);
    assert.deepEqual(await readdir(active), ['settings.json']);
    assert.ok(!(await readdir(join(out, 'runtime'))).includes('settings.json'));
    const reportText = await readFile(join(out, 'report.json'), 'utf8');
    assert.ok(!reportText.includes('secret-marker'));
    const report = JSON.parse(reportText);
    assert.equal(report.runs.length, 0);
    assert.equal(report.requests[0].state.tracks[0].expected, undefined);
    await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 60000 }), /EEXIST/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI compares the real baseline and saves partial Jev failures without live calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-bench-wire-'));
  try {
    const input = join(dir, 'sample.json');
    await writeFile(input, JSON.stringify(fixture()));
    const mock = join(dir, 'mock.mjs');
    await writeFile(mock, `
      globalThis.fetch = async (url, init) => {
        const request = JSON.parse(init.body);
        if (String(url).startsWith('http://127.0.0.1:1/v1/')) {
          const name = request.tools[0].function.name;
          return new Response(JSON.stringify({
            id: 'mock', created: 1, model: 'test', object: 'chat.completion',
            choices: [{ index: 0, finish_reason: 'tool_calls', message: {
              role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function',
                function: { name, arguments: JSON.stringify({ results: [{ moods: ['energetic'], energy: 'high' }] }) }
              }]
            } }], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 }
          }), { headers: { 'content-type': 'application/json' } });
        }
        if (String(url) !== 'https://openrouter.ai/api/alpha/decisions') throw new Error('Unexpected network call');
        if (request.model !== 'typesafe/jev-1.13') throw new Error('Wrong OpenRouter model');
        if (new Headers(init.headers).get('authorization') !== 'Bearer fake-router-key') throw new Error('Wrong key');
        if (request.state.tracks[0].title === 'B') {
          return new Response(JSON.stringify({ error: 'no quota' }), { status: 429 });
        }
        return new Response(JSON.stringify({
          model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 10 },
          answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id,
            q.type === 'noul' ? { type: 'noul', noul: id.endsWith('_m0') ? 0.9 : 0.1 }
              : { type: 'choice', choice: 'low', confidence: 1,
                  probabilities: { low: 1, medium: 0, high: 0, unknown: 0 } }
          ]))
        }), { headers: { 'content-type': 'application/json' } });
      };
    `);
    const out = join(dir, 'report');
    const script = fileURLToPath(new URL('./jev-tag-bench.ts', import.meta.url));
    const args = ['--import', 'tsx', '--import', mock, script, '--input', input,
      '--state-dir', join(dir, 'empty-state'), '--out', out, '--baseline', 'openai-compatible:test', '--batch-size', '1'];
    await assert.rejects(promisify(execFile)(process.execPath, args, {
      timeout: 60000, env: { ...process.env, OPENROUTER_API_KEY: 'fake-router-key', LLM_BASE_URL: 'http://127.0.0.1:1/v1' },
    }), (err: any) => err.code === 1);
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.equal(report.status, 'completed-with-errors');
    assert.equal(report.config.jevProvider, 'openrouter');
    assert.equal(report.runs.length, 4);
    assert.equal(report.runs[0].outcome, 'ok');
    assert.deepEqual(report.runs[0].predictions[0].moods, ['calm']);
    assert.equal(report.runs[3].outcome, 'error');
    assert.match(report.runs[3].error, /429/);
    assert.equal(report.summary.jev.failedBatches, 1);
    assert.equal(report.summary.jev.successfulTrackEvaluations, 1);
    assert.equal(report.summary.jev.reportedInputTokens, 100);
    assert.ok(Math.abs(report.summary.jev.estimatedCostUsd - 0.0000042) < 1e-12);
    assert.equal(report.summary.baseline.failedBatches, 0);
    assert.equal(report.summary.baseline.successfulTrackEvaluations, 2);
    assert.equal(report.summary.baseline.reportedInputTokens, 400);
    const disagreements = JSON.parse(await readFile(join(out, 'disagreements.json'), 'utf8'));
    assert.equal(disagreements.length, 1);
    assert.deepEqual(disagreements[0].baseline.moods, ['energetic']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
