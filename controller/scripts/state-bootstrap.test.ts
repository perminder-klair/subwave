// Regression tests for the shared-state bootstrap in the two supervisors
// (docker/broadcast-entrypoint.sh and docker/aio/supervisor.sh:
// bootstrap_state_dirs).
//
// #1300 bug 10. The bootstrap creates the state subdirs and chmod 777s them,
// because the controller and analyzer containers write here as OTHER uids and
// operators shouldn't have to chown a bind-mount source before first boot. The
// broadcast entrypoint runs under `set -eu`, so every one of those mkdir/chmod
// calls was load-bearing: a state path on a mount that refuses the change —
// a read-only bind, an NFS export without the right perms, exFAT/NTFS on the
// cheap big disk people move the stem cache to — aborted the entrypoint BEFORE
// icecast started. Compose then reports `dependency failed to start: container
// sub-wave-broadcast is unhealthy`, which names neither the path nor the chmod.
// Measured on subwave-broadcast:latest with a read-only mount at
// /var/sub-wave/archive: exit=1, health=unhealthy, one line of output.
//
// The station has no business refusing to boot over a permission convenience.
// The load-bearing properties, in order of what they protect:
//   1. An unusable path NEVER aborts the bootstrap — the remaining dirs are
//      still prepared and the caller still reaches icecast. A supervisor that
//      won't start is strictly worse than one running on a degraded mount:
//      icecast still serves and the dead-air guard still airs the emergency
//      loop, but an exited container airs nothing.
//   2. It WARNS, naming the path. The whole cost of this bug was a symptom
//      three layers from its cause; a warning naming the dir is the fix for
//      that, and it has to survive into `docker logs`.
//   3. A dir that exists and is world-writable is SILENT even if chmod could
//      not be applied. chmod 777 is the means; writability by the other uids
//      is the end. Warning on an already-correct mount trains operators to
//      ignore the line that matters.
//   4. The happy path stays silent, because this runs on every boot.
//
// Both supervisors are driven here from ONE table: they carry the same block
// for the same reason, and the AIO's copy (which runs under `set -u`, so it
// only ever printed a raw `chmod:` error) drifting away from the broadcast
// one is how this class comes back.
//
// Run: `tsx scripts/state-bootstrap.test.ts`.
//
// node:assert-via-tsx style, matching scripts/aio-analyzer-heavy.test.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const docker = join(here, '..', '..', 'docker');

// The two scripts, each sourced in library mode so the bootstrap runs without
// booting a station. Same function name in both — that IS the lockstep.
const SUPERVISORS = [
  { name: 'broadcast-entrypoint.sh', path: join(docker, 'broadcast-entrypoint.sh'), lib: 'SUBWAVE_BROADCAST_LIB' },
  { name: 'aio/supervisor.sh', path: join(docker, 'aio', 'supervisor.sh'), lib: 'SUBWAVE_SUPERVISOR_LIB' },
] as const;

for (const s of SUPERVISORS) {
  assert.ok(existsSync(s.path), `${s.name} not found at ${s.path}`);
}

type Run = { status: number; out: string };

// Drive bootstrap_state_dirs() against a scratch state dir. `set -eu` is set
// here too — the point of the test is that the function survives a failure
// under the same shell options the real entrypoint uses.
function bootstrap(
  script: string, lib: string, stateRoot: string, stateDir: string,
  extraEnv: Record<string, string> = {},
): Run {
  const cmd = `set -eu; ${lib}=1 source "$1"; bootstrap_state_dirs "$2" "$3" 2>&1`;
  try {
    const out = execFileSync('bash', ['-c', cmd, 'bash', script, stateRoot, stateDir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH ?? '', ...extraEnv },
    });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// Every subdir the bootstrap is responsible for. `stems` and `transitions` are
// the analyzer's (uid 10001) — they were missing from the list, which is why a
// bind mount at <state>/stems landed root-owned and unwritable, i.e. why
// "relocate the stem cache to a bigger disk" did not work even once the
// entrypoint stopped aborting.
const SUBDIRS = [
  'voice', 'voices', 'archive', 'jingles', 'logs', 'sessions', 'sfx', 'stems', 'transitions',
];

const tmp = mkdtempSync(join(tmpdir(), 'subwave-state-bootstrap-'));
let failures = 0;

function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${label}\n       ${(err as Error).message.split('\n')[0]}`);
  }
}

let caseNo = 0;
function scratch(): { root: string; dir: string } {
  const root = join(tmp, `case-${caseNo++}`);
  mkdirSync(root, { recursive: true });
  return { root, dir: root };
}

for (const s of SUPERVISORS) {
  console.log(`\n${s.name}`);

  // 1. Happy path: every dir prepared, world-writable, and not one line of
  //    output. This is what every boot on every install does.
  check('happy path creates every state subdir, silently', () => {
    const { root, dir } = scratch();
    const r = bootstrap(s.path, s.lib, root, dir);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.out}`);
    assert.equal(r.out.trim(), '', `expected silence, got: ${r.out}`);
    for (const d of SUBDIRS) {
      assert.ok(existsSync(join(dir, d)), `${d} not created`);
      const mode = statSync(join(dir, d)).mode & 0o777;
      assert.equal(mode & 0o002, 0o002, `${d} is not world-writable (mode ${mode.toString(8)})`);
    }
    // reload_mode="watch" needs these to exist before liquidsoap starts.
    assert.ok(existsSync(join(dir, 'auto.m3u')), 'auto.m3u not created');
    assert.ok(existsSync(join(dir, 'jingles.m3u')), 'jingles.m3u not created');
    assert.ok(existsSync(join(dir, 'archive', '.ndignore')), '.ndignore not created');
  });

  // 2. THE BUG. One state path is unusable. Must not abort, must say WHICH
  //    path, and must still prepare every other dir.
  //
  //    The reported trigger is a mount that refuses mkdir/chmod (read-only
  //    bind, NFS, exFAT), which cannot be staged without root — an unpriv
  //    process owns its own scratch dirs, so chmod always succeeds on them.
  //    A plain file where the dir belongs makes the same path unusable
  //    through the same branch (mkdir fails, the result is not a dir), so it
  //    pins the control flow this test exists for. The genuine read-only
  //    mount is covered at the image level: `docker run` with `-v ...:ro` at
  //    /var/sub-wave/archive, which exited 1 / unhealthy before this fix.
  check('an unusable state path warns, names itself, and does not abort', () => {
    const { root, dir } = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stems'), 'not a directory');
    const r = bootstrap(s.path, s.lib, root, dir);
    assert.equal(r.status, 0, `bootstrap aborted (exit ${r.status}) instead of degrading: ${r.out}`);
    assert.match(r.out, /stems/, `warning does not name the path: ${r.out}`);
    assert.match(r.out, /WARNING/i, `not surfaced as a warning: ${r.out}`);
    // The whole point: the boot carries on and the rest of the state dir is
    // still prepared. One bad mount must not cost the station the others.
    for (const d of SUBDIRS.filter(x => x !== 'stems')) {
      assert.ok(existsSync(join(dir, d)), `${d} was skipped after the bad path`);
    }
    assert.ok(existsSync(join(dir, 'auto.m3u')), 'auto.m3u skipped after the bad path');
  });

  // 3. A read-only mount that is ALREADY world-writable is a working config —
  //    chmod refusing to re-apply 777 changes nothing and must not warn.
  check('an unchangeable but already-writable dir stays silent', () => {
    const { root, dir } = scratch();
    for (const d of SUBDIRS) mkdirSync(join(dir, d), { recursive: true, mode: 0o777 });
    for (const d of SUBDIRS) chmodSync(join(dir, d), 0o777);
    const r = bootstrap(s.path, s.lib, root, dir);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.out}`);
    assert.equal(r.out.trim(), '', `expected silence on a working mount, got: ${r.out}`);
  });

  // 4. The analyzer writes stems as uid 10001. If the bootstrap ever stops
  //    covering that dir, relocating the stem cache to a bind mount silently
  //    goes back to being unwritable — the second half of bug 10.
  check('stems and transitions are world-writable for the analyzer uid', () => {
    const { root, dir } = scratch();
    const r = bootstrap(s.path, s.lib, root, dir);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.out}`);
    for (const d of ['stems', 'transitions']) {
      const mode = statSync(join(dir, d)).mode & 0o777;
      assert.equal(mode & 0o002, 0o002, `${d} not writable by other uids (mode ${mode.toString(8)})`);
    }
  });

  // 5. A RELOCATED stem cache (STEMS_DIR in .env → the container path
  //    SUBWAVE_STEMS_DIR) is outside the state dir, so the subdir loop above
  //    never touches it. Without its own entry the bind mount keeps the
  //    root-owned 755 Docker gives a freshly created source — the analyzer
  //    (uid 10001) then cannot write one stem, and the whole reason the
  //    operator moved the cache to a bigger disk is silently undone.
  check('a relocated stem cache root is created and world-writable', () => {
    const { root, dir } = scratch();
    const stems = join(root, 'relocated-stems');
    const r = bootstrap(s.path, s.lib, root, dir, { SUBWAVE_STEMS_DIR: stems });
    assert.equal(r.status, 0, `exited ${r.status}: ${r.out}`);
    assert.equal(r.out.trim(), '', `expected silence, got: ${r.out}`);
    assert.ok(existsSync(stems), 'relocated stems root not created');
    const mode = statSync(stems).mode & 0o777;
    assert.equal(mode & 0o002, 0o002, `relocated stems root mode ${mode.toString(8)}`);
    // Still does the in-state dirs — relocation replaces nothing.
    for (const d of SUBDIRS) assert.ok(existsSync(join(dir, d)), `${d} skipped`);
  });

  // 6. Same never-fatal contract as every other path: the exFAT/NTFS/NFS disk
  //    people move the stem cache onto is exactly where chmod refuses, and
  //    that must cost a warning, not the broadcast.
  check('an unusable relocated stems root warns and does not abort', () => {
    const { root, dir } = scratch();
    const stems = join(root, 'relocated-stems');
    mkdirSync(root, { recursive: true });
    writeFileSync(stems, 'not a directory');
    const r = bootstrap(s.path, s.lib, root, dir, { SUBWAVE_STEMS_DIR: stems });
    assert.equal(r.status, 0, `bootstrap aborted (exit ${r.status}): ${r.out}`);
    assert.match(r.out, /relocated-stems/, `warning does not name the path: ${r.out}`);
    assert.match(r.out, /WARNING/i, `not surfaced as a warning: ${r.out}`);
    for (const d of SUBDIRS) assert.ok(existsSync(join(dir, d)), `${d} skipped`);
  });
}

rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nstate-bootstrap: all checks passed');
