import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { migrate } from '../src/sleeve-notes/db.js';
import { cachedDashboardRead, clearConnectionComputeCache, reconcileConnectionsInBackground, libraryConnectionStoriesInBackground } from '../src/sleeve-notes/connection-compute.js';

test('unfinished matching, searches and collection readouts cannot queue or cancel live dashboard reads', async (context) => {
  const root = createTempDir(join(tmpdir(), 'sleeve-compute-isolation-'));
  const db = new Database(join(root, 'notes.db'));
  migrate(db);
  const workers: EventEmitter[] = [];
  context.mock.method(childProcess, 'fork', () => {
    const worker = Object.assign(new EventEmitter(), {
      stderr: null,
      channel: { ref() {}, unref() {} },
      unref() {},
      kill() {},
      send(message: {id: number; kind: string; dashboard?: {kind: string}}, callback: (error: Error | null) => void) {
        callback(null);
        if (message.kind === 'dashboard' && message.dashboard?.kind !== 'readout') queueMicrotask(() => worker.emit('message', {id: message.id, result: '{"ready":true}'}));
        return true;
      },
    });
    workers.push(worker);
    return worker as unknown as ChildProcess;
  });
  syncBuiltinESMExports();
  try {
    const reconciliation = assert.rejects(reconcileConnectionsInBackground(db), /stopped/);
    const stories = assert.rejects(libraryConnectionStoriesInBackground(db, {search:'Band'}), /stopped/);
    const readout = assert.rejects(cachedDashboardRead({kind:'readout'},db), /stopped/);
    const display = cachedDashboardRead({kind: 'brain-coverage'}, db);
    assert.equal(workers.length, 4, 'matching, searches, collection statistics and live panels need independent processes');
    workers[0]!.emit('error', new Error('background process failed'));
    assert.deepEqual(JSON.parse(await display), {ready: true});
    await reconciliation;
    clearConnectionComputeCache();
    await stories;
    await readout;
  } finally {
    clearConnectionComputeCache();
    context.mock.restoreAll();
    syncBuiltinESMExports();
    db.close();
    await removeTempDir(root);
  }
});
