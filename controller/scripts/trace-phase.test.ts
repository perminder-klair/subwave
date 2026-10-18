// timePhase (observability/events.ts, #1723) records how long one pick step
// held the thread (`syncMs`) and how long it took overall (`ms`), inside the
// current trace, without changing what the step returns or throws.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-trace-phase-'));
process.env.STATE_DIR = stateDir;

const { timePhase, withTrace } = await import('../src/observability/events.js');

const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function phases(): Promise<Array<Record<string, any>>> {
  await sleep(100); // appendFile is fire-and-forget
  const dir = join(stateDir, 'logs');
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'))
    .map((l) => JSON.parse(l)).filter((e) => e.type === 'trace.phase');
}

test('sync, async and throwing phases are timed and pass through untouched', async () => {
  await withTrace({ kind: 'test' }, async () => {
    assert.equal(timePhase('sync', () => { busy(30); return 7; }), 7);
    const v = await timePhase('async', async () => { busy(20); await sleep(40); return 'x'; });
    assert.equal(v, 'x');
    assert.throws(() => timePhase('throws', () => { throw new Error('boom'); }), /boom/);
    await assert.rejects(timePhase('rejects', async () => { await sleep(1); throw new Error('late'); }), /late/);
  });
  const got = await phases();
  const by = Object.fromEntries(got.map((e) => [e.phase, e]));
  assert.deepEqual(Object.keys(by).sort(), ['async', 'rejects', 'sync', 'throws']);
  const traceId = by.sync.traceId;
  assert.ok(traceId, 'phase rides the current trace');
  for (const e of got) assert.equal(e.traceId, traceId);
  assert.ok(by.sync.syncMs >= 25 && by.sync.ms >= by.sync.syncMs, JSON.stringify(by.sync));
  assert.ok(by.async.syncMs >= 15 && by.async.syncMs < 40, `async sync part only: ${JSON.stringify(by.async)}`);
  assert.ok(by.async.ms >= 55, `async total includes the await: ${JSON.stringify(by.async)}`);
});
