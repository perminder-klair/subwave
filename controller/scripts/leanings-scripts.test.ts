import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import { createTempDir } from './test-utils/temp-dir.js';

const controller = fileURLToPath(new URL('../', import.meta.url));
const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
});
const fixture = z.object({ baseline: z.object({ id: z.string() }) }).parse(JSON.parse(readFileSync(join(controller, 'scripts/fixtures/agentic-leanings-review/shelby-opportunities.json'), 'utf8')));

async function runScript(script: string, args: string[], state: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', `scripts/${script}`, ...args], {
    cwd: controller, env: { ...process.env, STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    return output;
  } finally { clearTimeout(timeout); }
}

function snapshot(path: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(snapshot(join(path, entry.name)))) files[`${entry.name}/${name}`] = content;
    } else files[entry.name] = readFileSync(join(path, entry.name), 'base64');
  }
  return files;
}

test('replay leaves active station files untouched; evaluation sends actual treatment preferences', { timeout: 120_000 }, async (t) => {
  const state = createTempDir(join(tmpdir(), 'subwave-leanings-scripts-'));
  const requests: Array<z.infer<typeof requestSchema>> = [];
  const server = createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += String(chunk);
    const body = requestSchema.parse(JSON.parse(data));
    requests.push(body);
    const names = body.tools?.map((tool) => tool.function.name) ?? [];
    const name = names.includes('emit') ? 'emit' : names.includes('tracksTowardJourney') ? 'tracksTowardJourney' : 'done';
    const revealed = [...body.messages].reverse().find((message) => message.role === 'tool');
    const candidateId = typeof revealed?.content === 'string' ? /"id"\s*:\s*"([^"]+)"/.exec(revealed.content)?.[1] : undefined;
    const answer = name === 'emit'
      ? { selectedId: fixture.baseline.id, leaningsBasis: 'NO_LEANINGS_INFLUENCE', musicalReason: 'its taut rhythm keeps the sequence moving naturally', transition: null }
      : name === 'done' ? { id: candidateId ?? 'missing', reason: 'fresh texture', usedMusicalLeanings: false, leaningsTieBreak: null, transition: null } : {};
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: 'test',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(answer) } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const active = join(state, 'stations', 'test');
  mkdirSync(join(active, 'logs'), { recursive: true });
  writeFileSync(join(state, 'stations', 'active.json'), JSON.stringify({ activeId: 'test' }));
  writeFileSync(join(active, 'settings.json'), JSON.stringify({ llm: { provider: 'openai-compatible', model: 'test', baseUrl, providerBaseUrls: { 'openai-compatible': baseUrl }, fallback: { enabled: false } } }));
  writeFileSync(join(active, 'logs', 'events-sentinel.jsonl'), '{"type":"llm","tokens":99}\n');
  writeFileSync(join(active, 'queue.json'), '{"queue":["untouched"]}');
  const before = snapshot(state);
  const replay = await runScript('agentic-leanings-review-replay.ts', ['scripts/fixtures/agentic-leanings-review/shelby-opportunities.json', '1'], state);
  assert.match(replay, /proposed=/, 'a model call actually ran');
  assert.deepEqual(snapshot(state), before, 'telemetry, budgets, queue and settings must not change');
  const disposable = /Isolated STATE_DIR: (.+)/.exec(replay)?.[1];
  assert.ok(disposable);
  const events = readdirSync(join(disposable, 'logs')).filter((name) => name.startsWith('events-'));
  assert.ok(events.length > 0, 'LLM telemetry exists only in disposable state');
  rmSync(disposable, { recursive: true, force: true });
  requests.length = 0;
  const report = join(state, 'report.json');
  const evaluation = await runScript('leanings-eval.ts', ['--models', 'openai-compatible:test', '--base-url', baseUrl, '--iterations', '1', '--out', report], state);
  const systems = requests.map((request) => request.messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n'));
  assert.ok(systems.some((system) => /Favour electronic music, especially synth-pop/.test(system)), 'the treatment system prompt must contain actual supplied host preferences');
  assert.ok(systems.some((system) => !/Musical Leanings —/.test(system)), 'control remains preference-free');
  const results = z.object({ records: z.array(z.object({ outcome: z.string() })) }).parse(JSON.parse(readFileSync(report, 'utf8')));
  assert.ok(results.records.length > 0);
  assert.ok(results.records.every((record) => record.outcome === 'ok'), evaluation);
  const evalState = /Isolated STATE_DIR: (.+)/.exec(evaluation)?.[1];
  if (evalState) rmSync(evalState, { recursive: true, force: true });
});
