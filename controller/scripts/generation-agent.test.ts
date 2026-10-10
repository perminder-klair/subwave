import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { z } from 'zod';

process.env.STATE_DIR = createTempDir(path.join(tmpdir(), 'subwave-generation-'));
const settings = await import('../src/settings.js');
const { djAgent } = await import('../src/llm/sdk.js');

test('agent without discovery tools honors its tighter cascade deadline', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 0, model: 'test', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'emit-1', type: 'function', function: { name: 'emit', arguments: '{"ok":true}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }, 200);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(path.join(process.env.STATE_DIR!, 'settings.json'), JSON.stringify({ llm: { provider: 'openai-compatible', model: 'test', baseUrl: `http://127.0.0.1:${port}/v1` } }));
  await settings.load();
  try {
    await assert.rejects(djAgent({ system: 'test', messages: [{ role: 'user', content: 'test' }], tools: {}, schema: z.object({ ok: z.boolean() }), timeoutMs: 40 }), { name: 'AgentDeadlineError' });
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
