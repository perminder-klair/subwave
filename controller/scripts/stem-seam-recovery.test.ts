import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-stem-recovery-'));
process.env.STATE_DIR = root;
const { config } = await import('../src/config.js');
const { queue } = await import('../src/broadcast/queue.js');

after(() => {
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  rmSync(root, { recursive: true, force: true });
});

test('queue recovery renames legacy stem cues without applying the overlap twice', () => {
  const item = (stemBlend: object) => ({
    track: { title: 'X' }, queuedAt: new Date().toISOString(), stemBlend,
  });
  const legacy = { clipPath: '/clip.wav', blendStartSec: 214.8, inCueSec: 11.7 };
  writeFileSync(config.queue.file, JSON.stringify({
    upcoming: [item(legacy)], current: item(legacy),
    history: [item({ ...legacy, outCueSec: 215.3 }), { track: { title: 'Y' }, stemBlend: 'junk' }],
    tracksSinceJingle: 7,
  }));
  // Keep recovery's automatic re-drain off the file IPC path in this test.
  queue.senderBusy = true;
  try {
    queue.recover();
    for (const restored of [queue.upcoming[0], queue.current]) {
      assert.deepEqual(restored?.stemBlend, {
        clipPath: '/clip.wav', outCueSec: 214.8, inCueSec: 11.7,
      });
    }
    assert.deepEqual(queue.history[0].stemBlend, {
      clipPath: '/clip.wav', outCueSec: 215.3, inCueSec: 11.7,
    }, 'the current name wins if both names were persisted');
    assert.equal(queue.history.length, 2, 'a malformed legacy value cannot abort recovery');
    assert.equal(queue._tracksSinceJingle, 7, 'recovery continues after a malformed legacy value');
  } finally {
    queue.senderBusy = false;
  }
});
