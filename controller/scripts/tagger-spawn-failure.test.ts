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

import { createTempDir } from './test-utils/temp-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const STATE = createTempDir(join(tmpdir(), 'subwave-tagger-spawn-'));
process.env.STATE_DIR = STATE;

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
    writeFileSync(join(STATE, 'tagger.pid'), JSON.stringify({ pid: 2147483647 }));
    assert.doesNotThrow(() => tagger.startTagger({ mode: 'tag', limit: 1 } as any));
    // The 'error' event lands on the next tick(s); give it room.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(existsSync(join(STATE, 'tagger.pid')), false, 'failed spawn clears the cross-restart lock');
    assert.equal(tagger.tagger.running, false, 'a run that never started must not read as running');
    assert.equal(tagger.tagger.lastRun?.outcome, 'failed');
    assert.ok(tagger.tagger.lastRun?.error, 'the reason must be recorded');
  } finally {
    process.env.PATH = realPath;
  }
});
