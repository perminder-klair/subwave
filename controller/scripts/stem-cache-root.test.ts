// Where the stem cache actually lives (music/stem-cache.ts resolveStemsRoot).
//
// The compose files bind-mount STEMS_DIR (a host path) at ONE fixed container
// path and hand that path down as SUBWAVE_STEMS_DIR. A fixed path is forced:
// compose cannot read state/stations/active.json, so it cannot know which
// station a boot will serve. But stemsRoot() is derived from config.stateDir,
// which on a multi-station install resolves to stations/<id>/ — so a mount at
// the install root and a cache under the station dir never met, and setting
// STEMS_DIR relocated nothing at all. The cache then kept growing on the state
// disk to whatever audio.stemCacheGb allows while the new disk stayed empty.
//
// The two properties pinned here:
//   1. No relocation → byte-identical to a pre-STEMS_DIR install. That is what
//      makes deleting STEMS_DIR from .env a clean undo.
//   2. Relocation keeps the per-station segment UNDER the new root. Navidrome
//      credentials are per-station (setup/config.ts), so two stations can index
//      different libraries; this cache is keyed by track id alone, and one
//      shared root would let station B render a transition from station A's
//      audio.
//
// Run: `tsx scripts/stem-cache-root.test.ts` (auto-discovered by npm test).

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTROLLER = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROOT = '/var/sub-wave';
const STATION = join(ROOT, 'stations', 'night-shift');
const MOUNT = '/var/sub-wave/stems';

const { resolveStemsRoot } = await import('../src/music/stem-cache.js');

test('unset relocation keeps the single-station path unchanged', () => {
  assert.equal(
    resolveStemsRoot({ stateRoot: ROOT, stateDir: ROOT }),
    join(ROOT, 'stems'),
  );
  // '' and whitespace are the compose shapes of "operator set nothing":
  // ${STEMS_DIR:+...} renders an empty string when STEMS_DIR is absent.
  assert.equal(
    resolveStemsRoot({ stateRoot: ROOT, stateDir: ROOT, relocated: '' }),
    join(ROOT, 'stems'),
  );
  assert.equal(
    resolveStemsRoot({ stateRoot: ROOT, stateDir: ROOT, relocated: '   ' }),
    join(ROOT, 'stems'),
  );
});

test('unset relocation keeps the multi-station path under the station dir', () => {
  assert.equal(
    resolveStemsRoot({ stateRoot: ROOT, stateDir: STATION }),
    join(STATION, 'stems'),
  );
});

test('relocation moves a single-station cache to the mount itself', () => {
  assert.equal(
    resolveStemsRoot({ stateRoot: ROOT, stateDir: ROOT, relocated: MOUNT }),
    MOUNT,
  );
});

test('relocation keeps each station in its own segment under the mount', () => {
  // THE BUG: this used to be join(STATION, 'stems') — on the state disk, not
  // the relocated one — so STEMS_DIR was a silent no-op for multi-station.
  assert.equal(
    resolveStemsRoot({ stateRoot: ROOT, stateDir: STATION, relocated: MOUNT }),
    join(MOUNT, 'stations', 'night-shift'),
  );
  // Two stations must not collide: same track id, different Navidrome.
  const other = join(ROOT, 'stations', 'breakfast');
  assert.notEqual(
    resolveStemsRoot({ stateRoot: ROOT, stateDir: other, relocated: MOUNT }),
    resolveStemsRoot({ stateRoot: ROOT, stateDir: STATION, relocated: MOUNT }),
  );
});

test('a state dir outside the root never climbs out of the mount', () => {
  // Native dev can point STATE_DIR anywhere; path.relative() would answer
  // with '..' segments and put the cache above the mount the operator gave us.
  const outside = resolveStemsRoot({
    stateRoot: ROOT, stateDir: '/srv/elsewhere', relocated: MOUNT,
  });
  assert.equal(outside, MOUNT);
  assert.ok(!outside.includes('..'), `escaped the mount: ${outside}`);
});

test('the live stemsRoot()/dirFor() pair reads config, station segment included', async () => {
  // config.ts resolves STATE_DIR once at import, so this drives the real
  // module in a child process with a staged multi-station state dir.
  const { execFileSync } = await import('node:child_process');
  const tmp = mkdtempSync(join(tmpdir(), 'subwave-stems-root-'));
  try {
    mkdirSync(join(tmp, 'stations', 'night-shift'), { recursive: true });
    writeFileSync(join(tmp, 'stations', 'active.json'), '{"activeId":"night-shift"}');
    // `.then`, not top-level await: tsx -e transforms as CJS, which rejects it.
    const script =
      "import('./src/music/stem-cache.js').then((m) => " +
      'process.stdout.write(m.stemsRoot() + "\\n" + m.dirFor("trk-1")));';
    const out = execFileSync(join(CONTROLLER, 'node_modules', '.bin', 'tsx'), ['-e', script], {
      encoding: 'utf8',
      cwd: CONTROLLER,
      env: { ...process.env, STATE_DIR: tmp, SUBWAVE_STEMS_DIR: MOUNT },
    });
    const [root, dir] = out.split('\n');
    assert.equal(root, join(MOUNT, 'stations', 'night-shift'));
    assert.equal(dir, join(MOUNT, 'stations', 'night-shift', 'trk-1'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
