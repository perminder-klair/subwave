// settings.stream.maxListeners — Icecast's <limits><clients> ceiling, and the
// last of the AIO/Unraid config-parity gaps from #1300 (FR 15 + the docs list).
//
// Before this, the ceiling came ONLY from ICECAST_MAX_CLIENTS. That is fine on
// compose, where there is a root .env to put it in, and unreachable on the AIO
// image, where there is no .env and the Unraid template exposes no such field.
// Some countries calculate licensing fees on simultaneous listener capacity, so
// "you cannot set this" is a stronger problem than a missing convenience.
//
// Two halves are pinned here, because each fails silently on its own:
//
//   1. The SETTING survives a controller restart. settings.load() composes the
//      stream block explicitly rather than spreading DEFAULTS, so a field
//      missing from load() saves fine, works for the rest of that process, and
//      then vanishes on the next cold start — after which the handoff file
//      carries the DEFAULT and the operator's ceiling quietly reverts. Hence a
//      cold-load round trip: an in-process assertion passes on the broken code.
//      (Same class as tts.cloud.compatParams #1317 and llm.repeatPenalty #918.)
//
//   2. The two SUPERVISORS resolve the value identically, and env WINS. The
//      env var shipped first and is wired into all three compose files, so
//      demoting it would silently re-ceiling a configured station on upgrade.
//      docker/broadcast-entrypoint.sh and docker/aio/supervisor.sh carry the
//      same resolve_max_clients(); a drift between them is exactly the class
//      the root CLAUDE.md's "keep the entrypoint and the AIO supervisor in
//      lockstep" rule exists for, so both are driven from ONE table below.
//
// No containers and no network: the shell half sources each supervisor in
// library mode against a scratch state dir.
//
// Run: `npm test -- max-listeners`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const docker = join(here, '..', '..', 'docker');

// ---------------------------------------------------------------------------
// 1. The setting: cold-load round trip
// ---------------------------------------------------------------------------

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/llm-repeat-penalty.test.ts).
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-max-listeners-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { LIQ_ICECAST_MAX_CLIENTS_PATH } = await import('../src/settings/liquidsoap.js');
const { STREAM_MAX_LISTENERS_BOUNDS, streamPatchSchema } = await import('../src/schemas/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(stream: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ stream }));
  setCache(null);
  await settings.load();
  return settings.get().stream;
}

test('an absent setting coerces to the ceiling the entrypoint always defaulted to', async () => {
  const stream = await coldLoad({});
  // Byte-identical icecast.xml on upgrade is the whole point: 100 is what
  // `${ICECAST_MAX_CLIENTS:-100}` rendered before this setting existed.
  assert.equal(stream.maxListeners, 100);
  assert.equal(DEFAULTS.stream.maxListeners, 100);
});

test('a configured ceiling survives a controller restart', async () => {
  const stream = await coldLoad({ maxListeners: 400 });
  assert.equal(stream.maxListeners, 400);
});

test('the load path bounds against the same constant the save path checks', async () => {
  // A hand-edited settings.json is the input here, so load() repairs rather
  // than throws. Both directions, plus a non-integer, fall back to the default
  // instead of reaching icecast.xml.
  for (const bad of [0, -5, 10001, 12.5, '400', null, {}]) {
    const stream = await coldLoad({ maxListeners: bad });
    assert.equal(
      stream.maxListeners,
      DEFAULTS.stream.maxListeners,
      `stored maxListeners=${JSON.stringify(bad)} should fall back`,
    );
  }
  // The edges themselves are legal, and they are the SHARED constant — a
  // hand-copied pair here is how the save path and the load path drift.
  assert.equal((await coldLoad({ maxListeners: STREAM_MAX_LISTENERS_BOUNDS.min })).maxListeners, 1);
  assert.equal((await coldLoad({ maxListeners: STREAM_MAX_LISTENERS_BOUNDS.max })).maxListeners, 10000);
});

test('the save path refuses what the load path repairs', () => {
  assert.equal(streamPatchSchema.safeParse({ maxListeners: 400 }).success, true);
  for (const bad of [0, -1, 10001, 'lots']) {
    const r = streamPatchSchema.safeParse({ maxListeners: bad });
    assert.equal(r.success, false, `maxListeners=${JSON.stringify(bad)} should be refused`);
  }
});

test('a save writes the handoff file the supervisors read', async () => {
  await coldLoad({});
  await settings.update({ stream: { maxListeners: 250 } });
  assert.ok(existsSync(LIQ_ICECAST_MAX_CLIENTS_PATH), 'handoff file not written');
  assert.equal(readFileSync(LIQ_ICECAST_MAX_CLIENTS_PATH, 'utf8'), '250');
});

test('changing the ceiling asks for a mixer restart', async () => {
  await coldLoad({ maxListeners: 250 });
  // icecast.xml is rendered once at broadcast boot, so a change that does not
  // bounce the container is a change the listener never sees.
  const changed = await settings.update({ stream: { maxListeners: 300 } });
  assert.equal(changed.requiresRestart, true);
  // …and an idempotent save must NOT, or every unrelated settings write drags
  // a restart banner along with it.
  const same = await settings.update({ stream: { maxListeners: 300 } });
  assert.equal(same.requiresRestart, false);
});

// ---------------------------------------------------------------------------
// 2. The supervisors: one table, both copies
// ---------------------------------------------------------------------------

const SUPERVISORS = [
  { name: 'broadcast-entrypoint.sh', path: join(docker, 'broadcast-entrypoint.sh'), lib: 'SUBWAVE_BROADCAST_LIB' },
  { name: 'aio/supervisor.sh', path: join(docker, 'aio', 'supervisor.sh'), lib: 'SUBWAVE_SUPERVISOR_LIB' },
] as const;

const shellTmp = mkdtempSync(join(tmpdir(), 'subwave-max-listeners-sh-'));
let caseNo = 0;

// Drive resolve_max_clients() against a scratch state dir. `set -eu` is set
// here too — the resolution runs under the same shell options the real
// entrypoint uses, and an unset-variable slip there aborts before icecast.
function resolve(
  script: string,
  lib: string,
  opts: { file?: string; env?: string },
): { value: string; source: string } {
  const stateDir = join(shellTmp, `case-${caseNo++}`);
  mkdirSync(stateDir, { recursive: true });
  if (opts.file !== undefined) {
    writeFileSync(join(stateDir, 'liquidsoap_icecast_max_clients.txt'), opts.file);
  }
  const cmd = `set -eu; ${lib}=1 source "$1"; STATE_DIR="$2" resolve_max_clients`;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: process.env.PATH ?? '', STATE_DIR: stateDir };
  // Deliberately DELETE rather than set to '' for the unset case: the
  // resolution treats an empty env var as "not set" (an `ICECAST_MAX_CLIENTS=`
  // line is what every compose file emits when the operator left it blank),
  // and a test that only ever passed '' would not prove that.
  if (opts.env === undefined) delete env.ICECAST_MAX_CLIENTS;
  else env.ICECAST_MAX_CLIENTS = opts.env;

  const out = execFileSync('bash', ['-c', cmd, 'bash', script, stateDir], { encoding: 'utf8', env }).trim();
  const [value, source] = out.split(' ');
  return { value: value ?? '', source: source ?? '' };
}

for (const s of SUPERVISORS) {
  assert.ok(existsSync(s.path), `${s.name} not found at ${s.path}`);

  test(`${s.name}: the setting is used when no env var is set`, () => {
    assert.deepEqual(resolve(s.path, s.lib, { file: '400' }), { value: '400', source: 'settings' });
  });

  test(`${s.name}: an env var WINS over the setting`, () => {
    // The upgrade-safety property. An operator who pinned the var in .env keeps
    // exactly the ceiling they had, whatever the (defaulted) setting says.
    assert.deepEqual(
      resolve(s.path, s.lib, { file: '400', env: '900' }),
      { value: '900', source: 'ICECAST_MAX_CLIENTS' },
    );
  });

  test(`${s.name}: a blank env var means "not set", not "zero"`, () => {
    // Every compose file emits `ICECAST_MAX_CLIENTS=${ICECAST_MAX_CLIENTS:-}`,
    // so the blank case is the DEFAULT install, not an edge.
    assert.deepEqual(resolve(s.path, s.lib, { file: '400', env: '' }), { value: '400', source: 'settings' });
  });

  test(`${s.name}: a missing handoff file falls back to 100`, () => {
    // A station upgraded but not yet re-saved has no such file.
    assert.deepEqual(resolve(s.path, s.lib, {}), { value: '100', source: 'settings' });
  });

  test(`${s.name}: junk from either source falls back to 100, naming the source`, () => {
    // Never fail icecast at boot over this: a non-numeric value renders invalid
    // XML and a zero renders a station nobody can tune into. The source rides
    // the answer so the log can say where the junk came from.
    for (const junk of ['lots', '', '0', '-5', '12.5']) {
      assert.equal(resolve(s.path, s.lib, { file: junk }).value, '100', `file=${JSON.stringify(junk)}`);
    }
    for (const junk of ['lots', '0', '-5']) {
      const r = resolve(s.path, s.lib, { env: junk });
      assert.equal(r.value, '100', `env=${junk}`);
      assert.match(r.source, /^fallback:/, 'the fallback must name where the junk came from');
    }
  });
}
