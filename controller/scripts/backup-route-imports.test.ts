// Loading the backup route must not start the scheduler.
//
// broadcast/scheduler.ts watches the settings cache and rebuilds the coast
// playlist (auto.m3u) whenever its policy key moves, which opens library.db.
// The route reached it statically through broadcast/blocklist-effects.ts, so
// any process that loaded the route and restored a persona rebuilt the coast in
// the background. In voice-style-import.test.ts that rebuild landed inside a
// before/after snapshot of the state dir on some runs (library.db appearing),
// failing two tests at random. The route now loads blocklist-effects only when
// a restore brings a never-play list back. In the server, boot loads the
// scheduler anyway, so nothing changes there.
//
// Run: npm test -- backup-route-imports
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-backup-route-imports-'));
process.env.STATE_DIR = stateDir;
after(async () => { await removeTempDir(stateDir); });

const loaded: string[] = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    loaded.push(resolved.url);
    return resolved;
  },
});

test('the backup route loads without the scheduler', async () => {
  await import('../src/routes/backup.js');
  const ours = loaded.filter((url) => url.includes('/controller/src/'));
  assert.ok(ours.some((url) => url.endsWith('/src/routes/backup.ts')), 'the hook saw the route load');
  assert.deepEqual(ours.filter((url) => /\/src\/broadcast\/scheduler\.ts$/.test(url)), []);
});
