// The request breaker exists to notice a model that can't drive the harness.
// These go through the real runRequest with only the agent run stubbed. An open
// breaker lasts ten minutes, so each test takes its own hour on a past clock:
// nothing it opens reaches the next test or outlives the file.
import assert from 'node:assert/strict';
import test, { beforeEach, type TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-request-breaker-runs-'));
const settings = await import('../src/settings.js');
const djAgent = await import('../src/broadcast/dj-agent.js');
const { queue } = await import('../src/broadcast/queue.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { requestBreakerOpen, RequestIdentificationMiss } = await import('../src/broadcast/dj-agent/breaker.js');

beforeEach(async () => {
  await settings.load();
  await settings.update({ tts: { enabled: false }, llm: { requestMatching: 'agentic', dailyTokenCap: 0 } } as never);
});

let pastHour = Date.now() - 24 * 3_600_000;
function pastClock(t: TestContext) {
  pastHour += 3_600_000;
  t.mock.timers.enable({ apis: ['Date'], now: pastHour });
}

function agentAnswers(t: TestContext, run: Record<string, unknown>) {
  t.mock.method(requestAgent, 'run', async () => ({ steps: 1, ...run }));
}

const request = (signal?: AbortSignal) => djAgent.runRequest(queue, { requester: 'Listener', text: 'Bohemian Rhapsody by Queen', signal });

for (const [shape, object] of [['a fabricated id', { id: 'made-up' }], ['a null id', { id: null }]] as const) {
  test(`a run with no tool calls and ${shape} counts toward the request breaker`, async t => {
    pastClock(t);
    agentAnswers(t, { object, toolCalls: [], extras: { seen: new Map() } });
    for (let run = 0; run < 3; run++) {
      assert.equal(requestBreakerOpen(), false, `open after ${run} runs`);
      await assert.rejects(request(), (err: Error) => !(err instanceof RequestIdentificationMiss));
    }
    assert.equal(requestBreakerOpen(), true);
  });
}

test('a run that searched and found nothing is an expected miss, not a broken model', async t => {
  pastClock(t);
  agentAnswers(t, { object: { id: null }, toolCalls: [{ name: 'searchLibrary' }], extras: { seen: new Map() } });
  for (let run = 0; run < 4; run++) await assert.rejects(request(), RequestIdentificationMiss);
  assert.equal(requestBreakerOpen(), false);
});

test('a listener deadline that stops the agent counts against the request breaker', async t => {
  pastClock(t);
  const deadline = Object.assign(new Error('request resolution exceeded its deadline'), { name: 'AgentDeadlineError' });
  t.mock.method(requestAgent, 'run', async () => { throw deadline; });
  for (let run = 0; run < 3; run++) {
    const controller = new AbortController();
    controller.abort(deadline);
    await assert.rejects(request(controller.signal), { name: 'AgentDeadlineError' });
  }
  assert.equal(requestBreakerOpen(), true);
});
