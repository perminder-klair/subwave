// The daily purge tick's enable gate. The purge moves and deletes operator
// files, so off has to mean nothing happens at all, which only the tick itself
// can show: runScheduledOrphanPurge runs whenever it is called.
//
// Run: `npm test -- stem-orphan-tick`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-orphan-tick-'));
after(async () => { await removeTempDir(stateDir); });
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const cache = await import('../src/music/stem-cache.js');
const { queue } = await import('../src/broadcast/queue.js');
const { stemOrphanPurgeTick } = await import('../src/broadcast/scheduler.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });

const ROOT = cache.stemsRoot();
const QU = join(ROOT, '.orphan-quarantine');
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, cache.STEMS_MARKER), '{}');
db.upsertTrackMeta('in-the-library', { title: 'Song', artist: 'A', album: 'B', duration: 200 });

function seedOrphan(id: string) {
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'head-drums.flac'), 'x');
  const t = new Date(Date.now() - 2 * 86400_000);
  utimesSync(dir, t, t);
}

const purgeLog = () => queue.djLog.filter((e: { message: string }) => e.message.startsWith('Stem orphan purge:'));

test('with the setting off the tick touches nothing and says nothing', async () => {
  seedOrphan('stays-put');
  await coldLoadSettings({ audio: { stemOrphanPurgeEnabled: false } });
  await stemOrphanPurgeTick();
  assert.ok(existsSync(join(ROOT, 'stays-put')));
  assert.ok(!existsSync(join(QU, 'stays-put')));
  assert.equal(purgeLog().length, 0);
});

test('with no stored setting the tick is off too', async () => {
  seedOrphan('stays-put-too');
  await coldLoadSettings({});
  await stemOrphanPurgeTick();
  assert.ok(existsSync(join(ROOT, 'stays-put-too')));
  assert.equal(purgeLog().length, 0);
});

test('with the setting on the tick runs the pass and logs it', async () => {
  seedOrphan('moves');
  await coldLoadSettings({ audio: { stemOrphanPurgeEnabled: true } });
  await stemOrphanPurgeTick();
  assert.ok(!existsSync(join(ROOT, 'moves')));
  assert.ok(existsSync(join(QU, 'moves')));
  assert.equal(purgeLog().length, 1);
  assert.match(purgeLog()[0].message, /quarantined \d+, released 0, deleted 0/);
});
