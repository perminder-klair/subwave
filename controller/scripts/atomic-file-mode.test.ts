// An atomic replace keeps the file it replaces as private as it was, and a
// secret-bearing file asks for owner-only. rename(2) swaps in a NEW inode, so
// without this every save landed at 0666 & ~umask — undoing an operator's chmod
// and leaving settings.json (every inline credential) world-readable in a state
// dir other accounts can list.

import assert from 'node:assert/strict';
import { chmodSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-atomic-mode-'));
process.env.STATE_DIR = stateRoot;

const { writeFileAtomic, writeFileAtomicSync } = await import('../src/util/atomic-file.js');
const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');

const modeOf = (p: string) => statSync(p).mode & 0o777;
const umask = process.umask();

const writers = {
  async: (p: string, c: string, o?: { mode?: number }) => writeFileAtomic(p, c, o),
  sync: async (p: string, c: string, o?: { mode?: number }) => writeFileAtomicSync(p, c, o),
};

for (const [name, write] of Object.entries(writers)) {
  test(`${name}: a replace keeps the target's own mode`, async () => {
    const p = path.join(stateRoot, `${name}-keep.json`);
    writeFileSync(p, 'old');
    chmodSync(p, 0o640);
    await write(p, 'new');
    assert.equal(readFileSync(p, 'utf8'), 'new');
    assert.equal(modeOf(p), 0o640);
    // Wider than the umask would allow on create, and still kept exactly.
    chmodSync(p, 0o664);
    await write(p, 'newer');
    assert.equal(modeOf(p), 0o664);
  });

  test(`${name}: mode is the new-file mode and a ceiling on replace`, async () => {
    const fresh = path.join(stateRoot, `${name}-fresh.json`);
    await write(fresh, 'x', { mode: 0o600 });
    assert.equal(modeOf(fresh), 0o600);

    const legacy = path.join(stateRoot, `${name}-legacy.json`);
    writeFileSync(legacy, 'x');
    chmodSync(legacy, 0o644);
    await write(legacy, 'y', { mode: 0o600 });
    assert.equal(modeOf(legacy), 0o600, 'a wider file is tightened on its next write');

    chmodSync(legacy, 0o400);
    await write(legacy, 'z', { mode: 0o600 });
    assert.equal(modeOf(legacy), 0o400, 'a narrower operator choice is kept');
  });

  test(`${name}: with no target and no mode, the historical default applies`, async () => {
    const p = path.join(stateRoot, `${name}-default.json`);
    await write(p, 'x');
    assert.equal(modeOf(p), 0o666 & ~umask);
  });

  test(`${name}: a link at the target is replaced, never copied from`, async () => {
    const victim = path.join(stateRoot, `${name}-victim`);
    writeFileSync(victim, 'untouched');
    chmodSync(victim, 0o604);
    const p = path.join(stateRoot, `${name}-link.json`);
    symlinkSync(victim, p);
    await write(p, 'x', { mode: 0o600 });
    assert.equal(modeOf(p), 0o600);
    assert.equal(readFileSync(victim, 'utf8'), 'untouched');
    assert.equal(modeOf(victim), 0o604);
  });
}

test('the async writer still removes its own temp when the replace fails', async () => {
  const { mkdirSync } = await import('node:fs');
  const blocked = path.join(stateRoot, 'blocked.json');
  mkdirSync(blocked);
  await assert.rejects(writeFileAtomic(blocked, 'x', { mode: 0o600 }));
  assert.deepEqual(readdirSync(stateRoot).filter(n => n.startsWith('blocked.json.')), []);
});

test('settings.json is written owner-only, and tightened from a legacy 0644', async () => {
  const file = path.join(stateRoot, 'settings.json');
  writeFileSync(file, JSON.stringify({ station: 'Mode Test' }));
  chmodSync(file, 0o644);
  setCache(null);
  await settings.load();
  await settings.update({ station: 'Mode Test 2' } as never);
  assert.equal(modeOf(file), 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).station, 'Mode Test 2');
});
