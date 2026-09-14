// Regression tests for the AIO supervisor's liquidsoap log-path bootstrap
// (docker/aio/supervisor.sh: link_liquidsoap_log).
//
// radio.liq opens settings.log.file.path in Dtools.Log.init, so a path
// liquidsoap cannot open is a FATAL start error, not a missing log. #1196's
// unconditional `ln -s` could close a symlink cycle with a state-side
// logs -> /var/log/liquidsoap link and crash-loop the install (ELOOP).
//
// Every scenario asserts END STATE OPENABILITY: whatever shape the two paths
// start in, a file must be creatable at <LIQ_LOG_DIR>/radio.log when the
// function returns. Persistence into the state dir is subordinate to that.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, lstatSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(here, '..', '..', 'docker', 'aio', 'supervisor.sh');

assert.ok(existsSync(SUPERVISOR), `supervisor.sh not found at ${SUPERVISOR}`);

// Drive link_liquidsoap_log() against a scratch STATE_ROOT / log dir by
// sourcing the supervisor in library mode. Returns its stderr (the log lines).
// extraEnv lets a scenario override PATH etc. (scenario 9 stubs mountpoint(1)).
function runLinker(stateRoot: string, liqLogDir: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync(
    'bash',
    [
      '-c',
      // `log()` writes to stderr; fold it into stdout so tests can assert on
      // the warnings the operator would see in `docker logs`.
      `set -u; SUBWAVE_SUPERVISOR_LIB=1 source "$1"; link_liquidsoap_log 2>&1`,
      'bash',
      SUPERVISOR,
    ],
    {
      env: {
        ...process.env,
        SUBWAVE_STATE_ROOT: stateRoot,
        SUBWAVE_LIQ_LOG_DIR: liqLogDir,
        ...extraEnv,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

// The actual contract: can liquidsoap open its log file here?
function radioLogOpenable(liqLogDir: string): boolean {
  try {
    const fd = openSync(join(liqLogDir, 'radio.log'), 'a');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

type Scratch = { root: string; stateRoot: string; liqLogDir: string };

const scratches: string[] = [];
// Clean up on 'exit' rather than at the bottom of the file — the handler also
// fires when an assertion throws, so failed runs don't leak dirs into $TMPDIR.
process.on('exit', () => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});
function scratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'subwave-aio-log-'));
  scratches.push(root);
  const stateRoot = join(root, 'var', 'sub-wave');
  const liqLogDir = join(root, 'var', 'log', 'liquidsoap');
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(dirname(liqLogDir), { recursive: true });
  return { root, stateRoot, liqLogDir };
}

// <state>/logs -> /var/log/liquidsoap, which #1196 then linked back at
// <state>/logs. Pre-fix this produced the ELOOP crash loop; the linker must
// now break the cycle and leave an openable path.
{
  const { stateRoot, liqLogDir } = scratch();
  symlinkSync(liqLogDir, join(stateRoot, 'logs')); // the host-side half

  // Sanity: the cycle really does reproduce the reported failure first.
  symlinkSync(join(stateRoot, 'logs'), liqLogDir); // what #1196 added
  assert.equal(
    radioLogOpenable(liqLogDir),
    false,
    'precondition: the two-link cycle must make radio.log unopenable (ELOOP)',
  );

  const out = runLinker(stateRoot, liqLogDir);

  assert.ok(
    radioLogOpenable(liqLogDir),
    'ELOOP cycle: radio.log must be openable after the linker runs',
  );
  assert.ok(
    !lstatSync(join(stateRoot, 'logs')).isSymbolicLink(),
    'ELOOP cycle: the broken state-side link must be replaced by a real directory',
  );
  assert.match(out, /broken symlink/, 'ELOOP cycle: the repair should be logged');
}

// Writing through the in-container path must land in the state dir, which is
// the whole point of #1196 (routes/debug.ts tails <stateRoot>/logs/radio.log).
{
  const { stateRoot, liqLogDir } = scratch();
  symlinkSync(liqLogDir, join(stateRoot, 'logs'));
  symlinkSync(join(stateRoot, 'logs'), liqLogDir);

  runLinker(stateRoot, liqLogDir);
  writeFileSync(join(liqLogDir, 'radio.log'), 'on air\n');

  assert.equal(
    readFileSync(join(stateRoot, 'logs', 'radio.log'), 'utf8'),
    'on air\n',
    'ELOOP cycle: after repair the log must still persist into the state dir',
  );
}

// Neither path exists yet: link the container path at the state dir.
{
  const { stateRoot, liqLogDir } = scratch();

  runLinker(stateRoot, liqLogDir);

  assert.ok(radioLogOpenable(liqLogDir), 'fresh install: radio.log must be openable');
  assert.ok(
    lstatSync(liqLogDir).isSymbolicLink(),
    'fresh install: the container path should be a symlink into the state dir',
  );
  writeFileSync(join(liqLogDir, 'radio.log'), 'x');
  assert.ok(
    existsSync(join(stateRoot, 'logs', 'radio.log')),
    'fresh install: writes must persist into the state dir',
  );
}

// Pre-#1196 images left a plain directory at /var/log/liquidsoap, possibly
// with a radio.log already in it. It gets replaced by the link.
{
  const { stateRoot, liqLogDir } = scratch();
  mkdirSync(liqLogDir, { recursive: true });
  writeFileSync(join(liqLogDir, 'radio.log'), 'old\n');

  runLinker(stateRoot, liqLogDir);

  assert.ok(radioLogOpenable(liqLogDir), 'upgrade: radio.log must be openable');
  assert.ok(
    lstatSync(liqLogDir).isSymbolicLink(),
    'upgrade: a plain in-container dir should be replaced by the state-dir link',
  );
}

// The supervisor calls this on every boot; repeat runs must not degrade the
// result or nest a link inside the previous one (`ln -s` without -n plants
// the new link INSIDE a link-to-directory).
{
  const { stateRoot, liqLogDir } = scratch();

  for (let i = 0; i < 3; i++) runLinker(stateRoot, liqLogDir);

  assert.ok(radioLogOpenable(liqLogDir), 'idempotence: still openable after 3 runs');
  assert.ok(
    !existsSync(join(stateRoot, 'logs', 'logs')),
    'idempotence: must not nest a logs/ link inside the target',
  );
}

// <state>/logs pointing at nothing yields ENOENT rather than ELOOP, but it is
// the same class of fault and heals the same way.
{
  const { root, stateRoot, liqLogDir } = scratch();
  symlinkSync(join(root, 'nowhere'), join(stateRoot, 'logs'));

  runLinker(stateRoot, liqLogDir);

  assert.ok(radioLogOpenable(liqLogDir), 'dangling link: radio.log must be openable');
  assert.ok(
    !lstatSync(join(stateRoot, 'logs')).isSymbolicLink(),
    'dangling link: must be replaced by a real directory',
  );
}

// A <state>/logs symlink that resolves to a real directory elsewhere is an
// operator parking logs on another disk. Healing that would be destructive, so
// only BROKEN links get replaced.
{
  const { root, stateRoot, liqLogDir } = scratch();
  const elsewhere = join(root, 'mnt', 'big-disk', 'logs');
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(stateRoot, 'logs'));

  runLinker(stateRoot, liqLogDir);

  assert.ok(radioLogOpenable(liqLogDir), 'operator link: radio.log must be openable');
  assert.ok(
    lstatSync(join(stateRoot, 'logs')).isSymbolicLink(),
    'operator link: a symlink resolving to a real dir must be left alone',
  );
  writeFileSync(join(liqLogDir, 'radio.log'), 'y');
  assert.ok(
    existsSync(join(elsewhere, 'radio.log')),
    'operator link: writes must follow it to the operator’s directory',
  );
}

// If the state dir cannot host logs/ at all (here: a regular FILE sits where
// the directory belongs, so mkdir fails), the linker must NOT leave liquidsoap
// with an unopenable path. Persistence is sacrificed, the station is not.
{
  const { stateRoot, liqLogDir } = scratch();
  writeFileSync(join(stateRoot, 'logs'), 'not a directory');

  const out = runLinker(stateRoot, liqLogDir);

  assert.ok(
    radioLogOpenable(liqLogDir),
    'fallback: radio.log must be openable even when the state dir cannot host logs/',
  );
  assert.ok(
    !lstatSync(liqLogDir).isSymbolicLink(),
    'fallback: the container path should be a plain local directory',
  );
  assert.match(out, /WARNING/, 'fallback: the degraded mode must be logged loudly');
}

// The split stack's `${STATE_DIR}/logs:/var/log/liquidsoap` mapping copied
// into an AIO `docker run`. The mounted dir must be used as-is, and — the
// part the first cut of this fix got wrong — its CONTENTS must survive:
// `rm -rf` on a mountpoint cannot remove the mountpoint itself but deletes
// everything inside it, so an unguarded rm wiped the operator's log history
// on every boot. A real mount needs root, so mountpoint(1) is stubbed via
// PATH; the on-disk shape (a real, non-symlink dir) is exactly what the
// supervisor sees over a bind mount.
{
  const { root, stateRoot, liqLogDir } = scratch();
  mkdirSync(liqLogDir, { recursive: true });
  writeFileSync(join(liqLogDir, 'radio.log'), 'operator history\n');

  const stubBin = join(root, 'stub-bin');
  mkdirSync(stubBin);
  writeFileSync(
    join(stubBin, 'mountpoint'),
    '#!/usr/bin/env bash\n' +
      '# test stub: only $SUBWAVE_TEST_MOUNTPOINT is a mount ($1 is -q, $2 the path)\n' +
      '[ "$2" = "$SUBWAVE_TEST_MOUNTPOINT" ]\n',
    { mode: 0o755 },
  );

  const out = runLinker(stateRoot, liqLogDir, {
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    SUBWAVE_TEST_MOUNTPOINT: liqLogDir,
  });

  assert.ok(radioLogOpenable(liqLogDir), 'bind mount: radio.log must be openable');
  assert.ok(
    !lstatSync(liqLogDir).isSymbolicLink(),
    'bind mount: the mounted dir must not be replaced by a link',
  );
  assert.equal(
    readFileSync(join(liqLogDir, 'radio.log'), 'utf8'),
    'operator history\n',
    'bind mount: existing log history must NOT be wiped by the bootstrap',
  );
  assert.match(out, /is a mountpoint — leaving it/, 'bind mount: the decision should be logged');
}

// The reporter's state dir carries logs -> /var/log/liquidsoap (their
// workaround for the pre-#1196 missing-radio.log bug), and a FRESH fixed
// image has a plain real dir at the container path — so the state-side link
// RESOLVES and can't be caught by the broken-link check. Left in place it
// re-creates the cycle the moment the container dir is replaced by the link;
// the probe would then break the cycle but at the price of persistence.
// Step 1b must instead spot that the link resolves into $LIQ_LOG_DIR and
// replace it, ending in the fully-healed shape: real state dir, container
// path linked at it, writes persisting.
{
  const { stateRoot, liqLogDir } = scratch();
  mkdirSync(liqLogDir, { recursive: true });
  symlinkSync(liqLogDir, join(stateRoot, 'logs')); // resolves — not "broken"

  const out = runLinker(stateRoot, liqLogDir);

  assert.ok(radioLogOpenable(liqLogDir), 'cycle half: radio.log must be openable');
  assert.ok(
    !lstatSync(join(stateRoot, 'logs')).isSymbolicLink(),
    'cycle half: the state-side link into $LIQ_LOG_DIR must become a real directory',
  );
  assert.ok(
    lstatSync(liqLogDir).isSymbolicLink(),
    'cycle half: the container path should end up linked at the state dir (full heal, not fallback)',
  );
  writeFileSync(join(liqLogDir, 'radio.log'), 'healed\n');
  assert.equal(
    readFileSync(join(stateRoot, 'logs', 'radio.log'), 'utf8'),
    'healed\n',
    'cycle half: persistence must survive the heal — fallback mode would lose it',
  );
  assert.match(out, /cycle half/, 'cycle half: the repair should be logged');
}

console.log('aio-log-link: all assertions passed');
