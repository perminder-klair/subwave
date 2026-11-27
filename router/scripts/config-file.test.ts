// Reading config.json. The router runs as an unprivileged user and the
// controller hands it the file (#1827 review), so an unreadable file must say
// so — it used to read as "not valid JSON" — and handing it over (a chown,
// which changes neither mtime nor size) must count as a change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'router-config-file-'));
process.env.ROUTER_DIR = dir;
const { CONFIG_PATH, configStamp, readConfig } = await import('../src/config.js');

const asRoot = process.getuid?.() === 0;

test('an unreadable config.json names the permission problem', { skip: asRoot ? 'root reads anything' : false }, () => {
  writeFileSync(CONFIG_PATH, '{"version":1}');
  chmodSync(CONFIG_PATH, 0o000);
  try {
    const read = readConfig();
    assert.match(read.error ?? '', /cannot be read \(EACCES\).*ROUTER_UID/);
  } finally {
    chmodSync(CONFIG_PATH, 0o600);
  }
  assert.equal(readConfig().error, undefined);
});

test('a permission change alone changes the stamp', async () => {
  writeFileSync(CONFIG_PATH, '{"version":1}');
  const t = new Date('2026-01-01T00:00:00Z');
  utimesSync(CONFIG_PATH, t, t);
  const before = configStamp();
  // ctime moves on the kernel's coarse clock (a few ms per tick).
  await new Promise((ok) => setTimeout(ok, 30));
  chmodSync(CONFIG_PATH, 0o644);
  utimesSync(CONFIG_PATH, t, t);
  assert.notEqual(configStamp(), before);
});
