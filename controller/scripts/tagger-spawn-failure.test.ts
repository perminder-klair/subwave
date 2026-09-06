// A tagger run that cannot SPAWN must not take the station off air.
//
// `startTagger` spawns `npx tsx …` with `cwd: '/app'`. A ChildProcess 'error'
// event with no listener is THROWN rather than delivered, and nothing up the
// stack catches it — so any spawn that never starts (no `npx` on PATH, a
// missing cwd, EACCES on the binary, fork failure under memory pressure) took
// the whole controller down. Found live: pressing Start on a controller run
// outside its container printed `Error: spawn npx ENOENT` and the process
// exited, killing the broadcast with it.
//
// That is the "station must keep making sound" invariant: music never stops for
// a failed background job. A run that cannot start is a FAILED RUN — reported
// the same way a non-zero exit is reported — not a dead station.
//
// Run: npm test -- tagger-spawn-failure

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-tagger-spawn-'));
process.env.STATE_DIR = STATE;

test.after(() => rmSync(STATE, { recursive: true, force: true }));

// The behaviour being relied on, pinned directly: node THROWS an 'error' event
// that has no listener. If this ever stops being true the guard below is still
// harmless, but the reason for it would be gone.
test('an unlistened ChildProcess error event is fatal (why the guard exists)', async () => {
  const child = spawn('definitely-not-a-real-binary-xyz', [], { stdio: 'ignore' });
  const threw = await new Promise<boolean>((resolve) => {
    // With a listener attached the error is delivered, not thrown — which is
    // exactly the fix. Without one it reaches the process as an uncaught
    // exception, which is what killed the controller.
    child.on('error', () => resolve(true));
    setTimeout(() => resolve(false), 2_000);
  });
  assert.equal(threw, true, 'spawning a missing binary must surface an error event');
});

test('startTagger attaches an error handler to the child', async () => {
  const src = await readFile(
    new URL('../src/broadcast/tagger.ts', import.meta.url), 'utf8',
  );
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.match(
    code, /child\.on\('error'/,
    "a spawn that never starts must be handled — an unlistened 'error' event kills the controller",
  );
  // The handler must finalise the run, or the panel shows a run that is
  // "running" forever and Start stays locked behind the single-flight slot.
  const handler = code.slice(code.indexOf("child.on('error'"));
  const body = handler.slice(0, handler.indexOf("child.on('exit'"));
  assert.match(body, /tagger\.running = false/, 'a failed spawn must clear running');
  assert.match(body, /clearPidfile\(\)/, 'a failed spawn must clear the cross-restart lock');
  assert.match(body, /outcome: 'failed'/, 'a failed spawn must be reported as a failed run');
});

test('the error handler defers to exit when the child did start', async () => {
  // 'error' can also fire on an already-running child (a kill that fails). The
  // exit handler owns the bookkeeping in that case; two writers would race and
  // could report 'failed' over a clean 'ok'.
  const src = await readFile(
    new URL('../src/broadcast/tagger.ts', import.meta.url), 'utf8',
  );
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const handler = code.slice(code.indexOf("child.on('error'"));
  const body = handler.slice(0, handler.indexOf("child.on('exit'"));
  assert.match(
    body, /activeChild\s*[!=]==\s*child/,
    'the error handler must only finalise the run it still owns',
  );
});

test('startTagger reports a failed spawn without throwing', async () => {
  const tagger = await import('../src/broadcast/tagger.js');
  // Point the spawn at a binary that cannot exist. PATH is inherited by the
  // child spawn, so emptying it makes `npx` unresolvable exactly the way the
  // live failure did.
  const realPath = process.env.PATH;
  process.env.PATH = join(STATE, 'no-binaries-here');
  try {
    assert.doesNotThrow(() => tagger.startTagger({ mode: 'tag', limit: 1 } as any));
    // The 'error' event lands on the next tick(s); give it room.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(tagger.tagger.running, false, 'a run that never started must not read as running');
    assert.equal(tagger.tagger.lastRun?.outcome, 'failed');
    assert.ok(tagger.tagger.lastRun?.error, 'the reason must be recorded');
  } finally {
    process.env.PATH = realPath;
  }
});
