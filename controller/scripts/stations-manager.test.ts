// fs-level pins for the station manager against a throwaway root.
// Run: npx tsx scripts/stations-manager.test.ts

import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as manager from '../src/stations/manager.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-mgr-'));
try {
  // Seed a legacy single-station root.
  writeFileSync(join(root, 'settings.json'), '{"station":"Legacy FM"}');
  writeFileSync(join(root, 'setup-config.json'), '{}');
  writeFileSync(join(root, 'session.json'), '{}');
  writeFileSync(join(root, 'liquidsoap_crossfade.txt'), '4');
  writeFileSync(join(root, 'icecast-secrets.env'), 'SECRET=1');
  mkdirSync(join(root, 'jingles'));
  writeFileSync(join(root, 'jingles', 'a.wav'), 'x');

  // Single-station listing: one synthetic root entry.
  const single = manager.listStations(root, 'Legacy FM');
  assert.equal(single.length, 1);
  assert.equal(single[0].id, null);
  assert.equal(single[0].active, true);
  assert.equal(single[0].configured, true);

  // Conversion: everything moves except install-level entries.
  const mainId = manager.convertToMultiStation(root, 'Legacy FM');
  assert.equal(mainId, 'main');
  assert.ok(existsSync(join(root, 'stations', 'main', 'settings.json')));
  assert.ok(existsSync(join(root, 'stations', 'main', 'jingles', 'a.wav')));
  assert.ok(existsSync(join(root, 'icecast-secrets.env'))); // stayed
  assert.ok(!existsSync(join(root, 'settings.json')));      // moved
  assert.equal(manager.activeIdOnDisk(root), 'main');
  assert.equal(
    JSON.parse(readFileSync(join(root, 'stations', 'active.json'), 'utf8')).activeId,
    'main',
  );

  // Fresh create: identity card only, unconfigured.
  const fresh = await manager.createStation(root, {
    name: 'Night Shift', mode: 'fresh', currentName: 'Legacy FM',
  });
  assert.equal(fresh.id, 'night-shift');
  assert.equal(fresh.converted, false);
  const list = manager.listStations(root, 'x');
  const night = list.find((s) => s.id === 'night-shift');
  assert.equal(night?.configured, false);
  assert.equal(night?.name, 'Night Shift');

  // Env-configured installs (NAVIDROME_* in env, no setup-config.json anywhere)
  // mark EVERY station configured — env creds are install-level.
  const envList = manager.listStations(root, 'x', true);
  assert.ok(envList.every((s) => s.configured));

  // Duplicate: allowlist copies, runtime skipped, library.db via callback.
  writeFileSync(join(root, 'stations', 'main', 'library.db'), 'not-really-sqlite');
  const backups: string[] = [];
  const dup = await manager.createStation(root, {
    name: 'Night Shift', mode: 'duplicate', currentName: 'Legacy FM',
    backupLibraryDb: async (dest) => { backups.push(dest); },
  });
  assert.equal(dup.id, 'night-shift-2'); // slug collision → -2
  const dupDir = join(root, 'stations', 'night-shift-2');
  assert.ok(existsSync(join(dupDir, 'settings.json')));
  assert.ok(existsSync(join(dupDir, 'liquidsoap_crossfade.txt')));
  assert.ok(existsSync(join(dupDir, 'jingles', 'a.wav')));
  assert.ok(!existsSync(join(dupDir, 'session.json')));
  assert.deepEqual(backups, [join(dupDir, 'library.db')]);

  // Rename touches only the identity card.
  manager.renameStation(root, 'night-shift', 'Graveyard');
  assert.equal(
    JSON.parse(readFileSync(join(root, 'stations', 'night-shift', 'station.json'), 'utf8')).name,
    'Graveyard',
  );

  // Guards.
  assert.throws(() => manager.deleteStation(root, 'main'), /live/);
  assert.throws(() => manager.activateStation(root, 'main'), /already/);
  assert.throws(() => manager.activateStation(root, 'ghost'), /no such/i);
  assert.throws(() => manager.deleteStation(root, '../evil'), /invalid/);

  // Activate drains stale file-based IPC in the TARGET dir first — a leftover
  // next.txt from this station's last stint as live must not be replayed the
  // moment Liquidsoap starts polling it again after the switch, and a stale
  // now-playing.json must not be served as the current track after the boot.
  const nightShiftDir = join(root, 'stations', 'night-shift');
  writeFileSync(join(nightShiftDir, 'next.txt'), 'annotate:title=stale:file:///stale.mp3');
  writeFileSync(join(nightShiftDir, 'now-playing.json'), '{"title":"stale"}');
  writeFileSync(join(nightShiftDir, 'jingle-playing.json'), '{"filename":"stale.wav"}');

  // Activate + delete the loser.
  manager.activateStation(root, 'night-shift');
  assert.equal(manager.activeIdOnDisk(root), 'night-shift');
  assert.ok(!existsSync(join(nightShiftDir, 'next.txt')));
  assert.ok(!existsSync(join(nightShiftDir, 'now-playing.json')));
  assert.ok(!existsSync(join(nightShiftDir, 'jingle-playing.json')));
  manager.deleteStation(root, 'night-shift-2');
  assert.ok(!existsSync(dupDir));

  // MAX_STATIONS cap: fill the rack to 8 real station dirs, then the next
  // create must refuse with a clear error (and no partial dir left behind).
  for (let i = manager.listStations(root, 'x').length; i < 8; i++) {
    await manager.createStation(root, { name: `Filler ${i}`, mode: 'fresh', currentName: 'L' });
  }
  assert.equal(manager.listStations(root, 'x').length, 8);
  await assert.rejects(
    manager.createStation(root, { name: 'One Too Many', mode: 'fresh', currentName: 'L' }),
    /capped at 8/,
  );
  assert.ok(!existsSync(join(root, 'stations', 'one-too-many')));
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Conversion rollback (spec §6): a rename failing mid-loop best-effort moves
// every already-relocated entry back to the root and aborts with a clear
// error — isMultiStation() must report false again afterward.
const root2 = mkdtempSync(join(tmpdir(), 'subwave-mgr-rollback-'));
try {
  writeFileSync(join(root2, 'settings.json'), '{"station":"Legacy FM"}');
  writeFileSync(join(root2, 'session.json'), '{}');
  mkdirSync(join(root2, 'jingles'));
  writeFileSync(join(root2, 'jingles', 'a.wav'), 'x');
  writeFileSync(join(root2, 'icecast-secrets.env'), 'SECRET=1'); // install-level, never renamed

  let call = 0;
  const flakyRename = (src: string, dest: string) => {
    call += 1;
    if (call === 2) throw new Error('boom');
    renameSync(src, dest);
  };

  assert.throws(
    () => manager.convertToMultiStation(root2, 'Legacy FM', flakyRename),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /conversion failed/);
      assert.match(message, /boom/);
      return true;
    },
  );
  assert.ok(existsSync(join(root2, 'settings.json')));
  assert.ok(existsSync(join(root2, 'session.json')));
  assert.ok(existsSync(join(root2, 'jingles', 'a.wav')));
  assert.ok(existsSync(join(root2, 'icecast-secrets.env')));
  assert.equal(manager.isMultiStation(root2), false);
  assert.ok(
    !existsSync(join(root2, 'stations')) || readdirSync(join(root2, 'stations')).length === 0,
  );
} finally {
  rmSync(root2, { recursive: true, force: true });
}

// createStation: conversion succeeds, then something AFTER it (the duplicate
// copy loop's library.db backup) throws. The conversion is durable the
// instant it returns — pointer + stations/main are already on disk — so the
// thrown error must carry converted:true (the route uses this to schedule
// the restart despite the 400/500), and the partially-created new-station
// dir must be cleaned up rather than left behind half-populated.
const root3 = mkdtempSync(join(tmpdir(), 'subwave-mgr-create-fail-'));
try {
  writeFileSync(join(root3, 'settings.json'), '{"station":"Legacy FM"}');
  writeFileSync(join(root3, 'library.db'), 'not-really-sqlite'); // so the backup callback runs

  await assert.rejects(
    manager.createStation(root3, {
      name: 'X',
      mode: 'duplicate',
      currentName: 'Legacy FM',
      backupLibraryDb: async () => { throw new Error('backup boom'); },
    }),
    (err: unknown) => {
      assert.ok(err instanceof manager.StationCreateError);
      assert.equal(err.converted, true);
      assert.match(err.message, /backup boom/);
      return true;
    },
  );

  // Conversion stuck — stations/main exists with the moved settings.json.
  assert.ok(existsSync(join(root3, 'stations', 'main', 'settings.json')));
  assert.equal(manager.activeIdOnDisk(root3), 'main');
  // The partial new-station dir ("x", slugified from "X") is gone.
  assert.ok(!existsSync(join(root3, 'stations', 'x')));
} finally {
  rmSync(root3, { recursive: true, force: true });
}

// Duplicate with an unresolvable pointer (multi-station dir present, pointer
// corrupt) must refuse loudly rather than silently degrade to a fresh station.
const root4 = mkdtempSync(join(tmpdir(), 'subwave-mgr-nosrc-'));
try {
  mkdirSync(join(root4, 'stations', 'alpha'), { recursive: true });
  writeFileSync(join(root4, 'stations', 'active.json'), 'corrupt');
  await assert.rejects(
    manager.createStation(root4, { name: 'Copy', mode: 'duplicate', currentName: 'X' }),
    /no active station to duplicate from/,
  );
  assert.ok(!existsSync(join(root4, 'stations', 'copy')));
} finally {
  rmSync(root4, { recursive: true, force: true });
}

console.log('stations-manager.test: OK');
