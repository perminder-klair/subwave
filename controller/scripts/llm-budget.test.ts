// The daily LLM token tally (telemetry/budget.ts) against the recorder that
// feeds it (telemetry/log.ts record()).
//
// #1195: a call that throws is still billed, so the tally counts failed calls
// that reported usage; the listener-facing lifetime ticker deliberately does
// not. The live guard in log.ts and the seed filter in budget.ts are two
// copies of one policy, and a disagreement walks the tally BACKWARDS across a
// restart — hence the round trip through the events file at the end.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-budget-'));
process.env.STATE_DIR = root;

const { record, lifetimeTokenCount } = await import('../src/llm/internal/telemetry/log.js');
const { dailyTokensUsed, seedDailyUsageFromLog } = await import('../src/llm/internal/telemetry/budget.js');

const utcDay = () => new Date().toISOString().slice(0, 10);
const eventsFile = () => join(root, 'logs', `events-${utcDay()}.jsonl`);

// logEvent's append is fire-and-forget, so wait for the lines rather than
// racing them; fails loudly rather than silently asserting on 0.
async function waitForLlmEvents(want: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = existsSync(eventsFile())
      ? readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean)
        .filter((l) => { try { return JSON.parse(l)?.type === 'llm'; } catch { return false; } }).length
      : 0;
    if (seen >= want) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${want} llm events on the timeline (saw ${seen})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// record() reads only ok/usage for the counters.
const call = (ok: boolean, total: number | undefined) => ({
  kind: 'pick',
  ok,
  ms: 12,
  model: 'test-model',
  via: 'ai-sdk',
  ...(total === undefined ? {} : { usage: { input: 1, output: total - 1, total } }),
  ...(ok ? {} : { error: 'agent did not call the done tool before stopping' }),
});

try {
  assert.equal(dailyTokensUsed(), 0, 'fresh process starts the day at zero');
  assert.equal(lifetimeTokenCount(), 0, 'fresh process starts the lifetime ticker at zero');

  record(call(true, 100));
  assert.equal(dailyTokensUsed(), 100, 'a success counts toward the daily tally');
  assert.equal(lifetimeTokenCount(), 100, 'a success counts toward the lifetime ticker');

  // A failed call feeds the tally only (#1195): agent.ts sums every leg onto
  // err.usage, so the spend is real and the cap must see it.
  record(call(false, 250));
  assert.equal(dailyTokensUsed(), 350, 'a failed call with usage counts toward the daily tally');
  assert.equal(lifetimeTokenCount(), 100, 'a failed call must NOT move the listener-facing ticker');

  // Provider HTTP errors and deadline aborts throw bare: nothing to count, and
  // nothing may be invented.
  record(call(false, undefined));
  assert.equal(dailyTokensUsed(), 350, 'a usage-less failure adds nothing to the tally');
  assert.equal(lifetimeTokenCount(), 100, 'a usage-less failure adds nothing to the ticker');

  // A zero-token report (common on local rigs) is not a contribution.
  record(call(false, 0));
  record(call(true, 0));
  assert.equal(dailyTokensUsed(), 350, 'zero-token reports add nothing, ok or not');

  // Re-seed from the events file those calls wrote: a drift between the two
  // copies of the policy shows up here as the number moving backwards.
  const live = dailyTokensUsed();
  await waitForLlmEvents(5);
  const seeded = await seedDailyUsageFromLog();
  assert.equal(seeded, live, 'a mid-day restart re-seeds to the same number it was live at');
  assert.equal(dailyTokensUsed(), live, 'and the tally reads unchanged after the re-seed');
  assert.ok(seeded >= 250, 'the re-seed carries the failed call, not just the successes');

  console.log('llm-budget: OK (failed calls count toward the daily cap; ticker unmoved; seed round-trips)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
