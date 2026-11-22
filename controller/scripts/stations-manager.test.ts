// fs-level pins for the station manager against a throwaway root.
// Run: `npm test -- stations-manager`.

import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as manager from '../src/stations/manager.js';

const root = createTempDir(join(tmpdir(), 'subwave-mgr-'));
try {
  // Seed a legacy single-station root.
  writeFileSync(join(root, 'settings.json'), '{"station":"Legacy FM"}');
  writeFileSync(join(root, 'setup-config.json'), JSON.stringify({ navidrome: { url: 'http://music-a:4533', user: 'a', pass: 'secret-a' } }));
  writeFileSync(join(root, 'session.json'), '{}');
  writeFileSync(join(root, 'liquidsoap_crossfade.txt'), '4');
  writeFileSync(join(root, 'icecast-secrets.env'), 'SECRET=1');
  mkdirSync(join(root, 'jingles'));
  writeFileSync(join(root, 'jingles', 'a.wav'), 'x');
  mkdirSync(join(root, 'logs'));
  writeFileSync(join(root, 'logs', 'radio.log'), 'mixer log\n');
  writeFileSync(join(root, 'logs', 'radio.log.old'), 'rotated\n');
  writeFileSync(join(root, 'logs', 'web-dev.log'), 'next dev\n');
  writeFileSync(join(root, 'logs', 'events-2026-11-15.jsonl'), '{"type":"track.play"}\n');
  writeFileSync(join(root, 'logs', 'requests.log'), 'req\n');

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
  // logs/ stays at the root: the AIO links /var/log/liquidsoap at it and compose
  // bind-mounts it, so moving it left the mixer unable to open radio.log (#2349).
  // Only liquidsoap's (and the host CLI's) files stay; the station's own
  // history moves with it, so the daily token seed, the repeat backfill and the
  // orphan-name source still find it after the switch.
  assert.equal(readFileSync(join(root, 'logs', 'radio.log'), 'utf8'), 'mixer log\n');
  assert.equal(readFileSync(join(root, 'logs', 'radio.log.old'), 'utf8'), 'rotated\n');
  assert.equal(readFileSync(join(root, 'logs', 'web-dev.log'), 'utf8'), 'next dev\n');
  assert.deepEqual(readdirSync(join(root, 'logs')).sort(), ['radio.log', 'radio.log.old', 'web-dev.log']);
  assert.equal(
    readFileSync(join(root, 'stations', 'main', 'logs', 'events-2026-11-15.jsonl'), 'utf8'),
    '{"type":"track.play"}\n',
  );
  assert.deepEqual(readdirSync(join(root, 'stations', 'main', 'logs')).sort(), ['events-2026-11-15.jsonl', 'requests.log']);
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
  // Fresh create seeds the ON-AIR name — without it the first boot defaults
  // to "SUB/WAVE" while the rack card says otherwise.
  assert.equal(
    JSON.parse(readFileSync(join(root, 'stations', 'night-shift', 'settings.json'), 'utf8')).station,
    'Night Shift',
  );
  const list = manager.listStations(root, 'x');
  const night = list.find((s) => s.id === 'night-shift');
  assert.equal(night?.configured, false);
  assert.equal(night?.name, 'Night Shift');

  // Env credentials must not configure a new profile.
  const envList = manager.listStations(root, 'x', true);
  assert.equal(envList.find(s => s.id === 'main')?.configured, true);
  assert.equal(envList.find(s => s.id === 'night-shift')?.configured, false);

  // Duplicate copies presentation, but no music credentials or library data.
  writeFileSync(join(root, 'stations', 'main', 'library.db'), 'not-really-sqlite');
  writeFileSync(join(root, 'stations', 'main', 'schedule.json'), JSON.stringify({
    shows: [{ id: 'night', playlistIds: ['source-only'], excludedPlaylistIds: ['excluded'], genres: ['Jazz'] }],
    schedule: { '0': ['night'] },
  }));
  const dup = await manager.createStation(root, {
    name: 'Night Shift', mode: 'duplicate', currentName: 'Legacy FM',
  });
  assert.equal(dup.id, 'night-shift-2'); // slug collision → -2
  const dupDir = join(root, 'stations', 'night-shift-2');
  assert.ok(existsSync(join(dupDir, 'settings.json')));
  assert.ok(existsSync(join(dupDir, 'liquidsoap_crossfade.txt')));
  assert.ok(existsSync(join(dupDir, 'jingles', 'a.wav')));
  assert.ok(!existsSync(join(dupDir, 'session.json')));
  assert.ok(!existsSync(join(dupDir, 'library.db')));
  assert.ok(!existsSync(join(dupDir, 'setup-config.json')));
  assert.equal(manager.listStations(root, 'x', true).find(s => s.id === dup.id)?.configured, false);
  const copiedSchedule = JSON.parse(readFileSync(join(dupDir, 'schedule.json'), 'utf8'));
  assert.deepEqual(copiedSchedule.shows, [{ id: 'night', genres: ['Jazz'] }]);
  assert.deepEqual(copiedSchedule.schedule, { '0': ['night'] });
  // Duplicate overwrites the on-air name copied from the source.
  assert.equal(
    JSON.parse(readFileSync(join(dupDir, 'settings.json'), 'utf8')).station,
    'Night Shift',
  );

  // Rename updates the identity card AND the dir's on-air name.
  manager.renameStation(root, 'night-shift', 'Graveyard');
  assert.equal(
    JSON.parse(readFileSync(join(root, 'stations', 'night-shift', 'station.json'), 'utf8')).name,
    'Graveyard',
  );
  assert.equal(
    JSON.parse(readFileSync(join(root, 'stations', 'night-shift', 'settings.json'), 'utf8')).station,
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
  writeFileSync(join(nightShiftDir, 'jingle-now.txt'), 'annotate:subwave_kind="jingle":/stale.wav');
  writeFileSync(join(nightShiftDir, 'now-playing.json'), '{"title":"stale"}');
  writeFileSync(join(nightShiftDir, 'jingle-playing.json'), '{"filename":"stale.wav"}');

  // Activate + delete the loser.
  manager.activateStation(root, 'night-shift');
  assert.equal(manager.activeIdOnDisk(root), 'night-shift');
  assert.ok(!existsSync(join(nightShiftDir, 'next.txt')));
  assert.ok(!existsSync(join(nightShiftDir, 'jingle-now.txt')));
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
    (err: unknown) => {
      assert.ok(err instanceof manager.StationCreateError);
      assert.equal(err.field, undefined, 'a full rack cannot be fixed by a form field');
      assert.match(err.message, /capped at 8/);
      return true;
    },
  );
  assert.ok(!existsSync(join(root, 'stations', 'one-too-many')));
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Conversion rollback (spec §6): a rename failing mid-loop best-effort moves
// every already-relocated entry back to the root and aborts with a clear
// error — isMultiStation() must report false again afterward.
const root2 = createTempDir(join(tmpdir(), 'subwave-mgr-rollback-'));
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

// Rollback across the split logs/ (#2349): a failure after the station's logs
// moved puts every one back, loses none and leaves no copy under stations/. The
// failure is the post-loop setup-config write (a directory where the file
// should be, so readFileSync throws EISDIR), which runs after every rename
// whatever order readdir returns.
const logsRoot = createTempDir(join(tmpdir(), 'subwave-mgr-logs-rollback-'));
try {
  writeFileSync(join(logsRoot, 'settings.json'), '{"station":"Legacy FM"}');
  mkdirSync(join(logsRoot, 'setup-config.json'));
  mkdirSync(join(logsRoot, 'logs'));
  writeFileSync(join(logsRoot, 'logs', 'radio.log'), 'mixer\n');
  writeFileSync(join(logsRoot, 'logs', 'events-a.jsonl'), 'a\n');
  writeFileSync(join(logsRoot, 'logs', 'events-b.jsonl'), 'b\n');
  const logMoves: string[] = [];
  const recordingRename = (src: string, dest: string) => {
    if (src.includes(join('logs', 'events-')) && dest.includes('stations')) logMoves.push(src);
    renameSync(src, dest);
  };
  assert.throws(
    () => manager.convertToMultiStation(logsRoot, 'Legacy FM', recordingRename, { url: 'http://m:4533', user: 'u', pass: 'p' }),
    /conversion failed.*restored/,
  );
  assert.equal(logMoves.length, 2, 'precondition: both station logs moved before the failure');
  assert.deepEqual(readdirSync(join(logsRoot, 'logs')).sort(), ['events-a.jsonl', 'events-b.jsonl', 'radio.log']);
  assert.equal(readFileSync(join(logsRoot, 'logs', 'events-a.jsonl'), 'utf8'), 'a\n');
  assert.equal(readFileSync(join(logsRoot, 'logs', 'radio.log'), 'utf8'), 'mixer\n');
  assert.ok(existsSync(join(logsRoot, 'settings.json')));
  assert.equal(manager.isMultiStation(logsRoot), false);
} finally {
  await removeTempDir(logsRoot);
}

// A station log on another filesystem (logs/ is its own mount) cannot be
// renamed: it stays at the root and the conversion still succeeds.
const exdevRoot = createTempDir(join(tmpdir(), 'subwave-mgr-logs-exdev-'));
try {
  writeFileSync(join(exdevRoot, 'settings.json'), '{}');
  mkdirSync(join(exdevRoot, 'logs'));
  writeFileSync(join(exdevRoot, 'logs', 'events-a.jsonl'), 'a\n');
  const exdev = (src: string, dest: string) => {
    if (src.includes(join('logs', 'events-'))) {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    }
    renameSync(src, dest);
  };
  assert.equal(manager.convertToMultiStation(exdevRoot, 'Legacy FM', exdev), 'main');
  assert.equal(readFileSync(join(exdevRoot, 'logs', 'events-a.jsonl'), 'utf8'), 'a\n');
  assert.ok(existsSync(join(exdevRoot, 'stations', 'main', 'settings.json')));
} finally {
  await removeTempDir(exdevRoot);
}

// A logs/ that is a symlink (an operator parking logs on another disk) is left
// whole: the link and everything behind it stay where the operator put them.
const linkRoot = createTempDir(join(tmpdir(), 'subwave-mgr-logs-link-'));
try {
  const elsewhere = join(linkRoot, 'elsewhere');
  mkdirSync(join(linkRoot, 'legacy'));
  writeFileSync(join(linkRoot, 'legacy', 'settings.json'), '{}');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'events-a.jsonl'), 'a\n');
  symlinkSync(elsewhere, join(linkRoot, 'legacy', 'logs'));
  const legacy = join(linkRoot, 'legacy');
  assert.equal(manager.convertToMultiStation(legacy, 'Legacy FM'), 'main');
  assert.ok(lstatSync(join(legacy, 'logs')).isSymbolicLink());
  assert.equal(readFileSync(join(elsewhere, 'events-a.jsonl'), 'utf8'), 'a\n');
  assert.ok(!existsSync(join(legacy, 'stations', 'main', 'logs')));
} finally {
  await removeTempDir(linkRoot);
}

// createStation: conversion succeeds, then something AFTER it (the duplicate
// copy's schedule parsing) throws. The conversion is durable the
// instant it returns — pointer + stations/main are already on disk — so the
// thrown error must carry converted:true (the route uses this to schedule
// the restart despite the 400/500), and the partially-created new-station
// dir must be cleaned up rather than left behind half-populated.
const root3 = createTempDir(join(tmpdir(), 'subwave-mgr-create-fail-'));
try {
  writeFileSync(join(root3, 'settings.json'), '{"station":"Legacy FM"}');
  writeFileSync(join(root3, 'schedule.json'), 'invalid-json'); // copied schedule cannot be parsed

  await assert.rejects(
    manager.createStation(root3, {
      name: 'X',
      mode: 'duplicate',
      currentName: 'Legacy FM',
    }),
    (err: unknown) => {
      assert.ok(err instanceof manager.StationCreateError);
      assert.equal(err.converted, true);
      assert.match(err.message, /JSON/);
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

console.log('stations-manager.test: OK');
