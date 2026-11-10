// Exercise the report CLI against real log files, including station profiles
// and the factory phases that share a pick's trace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTempDir } from './test-utils/temp-dir.js';

const report = fileURLToPath(new URL('./trace-phase-report.mjs', import.meta.url));

function writePhases(stateDir: string, events: Array<{ traceId: string; phase: string; syncMs: number }>) {
  const logs = join(stateDir, 'logs');
  mkdirSync(logs, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(logs, `events-${day}.jsonl`), events
    .map((event) => JSON.stringify({ type: 'trace.phase', ms: event.syncMs, ...event })).join('\n') + '\n');
}

function runReport(stateDir: string): string {
  return execFileSync(process.execPath, [report], {
    env: { ...process.env, STATE_DIR: stateDir }, encoding: 'utf8',
  });
}

test('the report reads legacy single-station logs', () => {
  const root = createTempDir(join(tmpdir(), 'subwave-phase-report-'));
  writePhases(root, [{ traceId: 'legacy', phase: 'pick.libraryStats', syncMs: 12 }]);
  const output = runReport(root);
  assert.match(output, /files: 1/);
  assert.match(output, /pick\.libraryStats\s+1\s+12\s+12\s+12\s+12/);
  assert.match(output, /picks: 1 .*p50 12 ms, p95 12 ms, max 12 ms/);
});

test('the report finds each station profile under the install root', () => {
  const root = createTempDir(join(tmpdir(), 'subwave-phase-report-'));
  writePhases(join(root, 'stations', 'main'), [{ traceId: 'main', phase: 'pick.libraryStats', syncMs: 12 }]);
  writePhases(join(root, 'stations', 'night'), [{ traceId: 'night', phase: 'pick.advanceRun', syncMs: 24 }]);
  writeFileSync(join(root, 'stations', 'active.json'), JSON.stringify({ activeId: 'main' }));
  const output = runReport(root);
  assert.match(output, /files: 2/);
  assert.match(output, /pick\.libraryStats/);
  assert.match(output, /pick\.advanceRun/);
  assert.match(output, /picks: 2 /);
});

test('the report accepts a station directory directly', () => {
  const root = createTempDir(join(tmpdir(), 'subwave-phase-report-'));
  const station = join(root, 'stations', 'main');
  writePhases(station, [{ traceId: 'main', phase: 'pick.libraryStats', syncMs: 12 }]);
  assert.match(runReport(station), /files: 1/);
});

test('per-pick totals include factory preparation and exclude request agents', () => {
  const root = createTempDir(join(tmpdir(), 'subwave-phase-report-'));
  writePhases(root, [
    { traceId: 'pick', phase: 'pick.libraryStats', syncMs: 0 },
    { traceId: 'pick', phase: 'djAgentPick.buildSystem', syncMs: 30 },
    { traceId: 'pick', phase: 'djAgentPick.buildTools', syncMs: 4000 },
    { traceId: 'request', phase: 'djAgentRequest.buildSystem', syncMs: 5000 },
    { traceId: 'request', phase: 'djAgentRequest.buildTools', syncMs: 6000 },
  ]);
  const output = runReport(root);
  assert.match(output, /djAgentPick\.buildTools\s+1\s+4000\s+4000\s+4000\s+4000/);
  assert.match(output, /picks: 1 .*p50 4030 ms, p95 4030 ms, max 4030 ms/);
});
