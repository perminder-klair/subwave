// AIO compose-only analyzer knobs are inert. ANALYZER_HEAVY (#1300 bug 9)
// needs an image swap for CLAP/Demucs; ANALYZER_REPLICAS=0 (#1570) still spends
// RAM and CPU unless ANALYZE_PYTHON is cleared or ANALYZE_URL offloads the work.
// Set values warn only when the requested outcome differs from this image.
// Unset or empty values stay silent on every boot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(here, '..', '..', 'docker', 'aio', 'supervisor.sh');

assert.ok(existsSync(SUPERVISOR), `supervisor.sh not found at ${SUPERVISOR}`);

// Drive warn_if_analyzer_heavy_ignored() against a scratch venv by sourcing the
// supervisor in library mode. Returns its stderr (the log lines the operator
// would see in `docker logs`), folded into stdout.
function runWarn(variable: 'ANALYZER_HEAVY' | 'ANALYZER_REPLICAS', value: string | null, venvDir = ''): string {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SUBWAVE_ANALYZER_VENV: venvDir,
  };
  if (value === null) delete env[variable];
  else env[variable] = value;
  return execFileSync(
    'bash',
    [
      '-c',
      `set -u; SUBWAVE_SUPERVISOR_LIB=1 source "$1"; ${variable === 'ANALYZER_HEAVY' ? 'warn_if_analyzer_heavy_ignored' : 'warn_if_analyzer_replicas_ignored'} 2>&1`,
      'bash',
      SUPERVISOR,
    ],
    { env, encoding: 'utf8' },
  );
}

// A lean venv: librosa only, no torch. Mirrors WITH_CLAP=0.
function leanVenv(root: string): string {
  const venv = join(root, 'venv');
  mkdirSync(join(venv, 'lib', 'python3.13', 'site-packages', 'librosa'), { recursive: true });
  return venv;
}

// A heavy venv: torch present, the thing that actually makes CLAP/Demucs work.
function heavyVenv(root: string): string {
  const venv = leanVenv(root);
  const torch = join(venv, 'lib', 'python3.13', 'site-packages', 'torch');
  mkdirSync(torch, { recursive: true });
  writeFileSync(join(torch, '__init__.py'), '');
  return venv;
}

const tmp = createTempDir(join(tmpdir(), 'subwave-aio-heavy-'));

// 1. The reported case: set on a lean AIO. Must warn, and must name the image
//    swap — the variable itself is a dead end, so repeating it would be the
//    same non-advice the operator already followed.
test('set on a lean build warns and names the -aio-heavy image', () => {
  const out = runWarn('ANALYZER_HEAVY', '1', leanVenv(createTempDir(join(tmp, 'lean-'))));
  assert.match(out, /WARNING: ANALYZER_HEAVY is set, and it does NOTHING/);
  assert.match(out, /subwave-aio-heavy/);
  // Pointing an AIO operator at the bare analyzer image replaces their whole
  // station with an analysis micro-service (#966), so the warning has to
  // disclaim it rather than stay silent.
  assert.match(out, /NOT subwave-analyzer-heavy/);
});

// 2. Set on a heavy build. Still inert, but the capability is there — so this
//    is a note, not a warning. Anything alarming here sends an operator whose
//    setup is FINE looking for a problem.
test('set on a heavy build notes without warning', () => {
  const out = runWarn('ANALYZER_HEAVY', '1', heavyVenv(createTempDir(join(tmp, 'heavy-'))));
  assert.match(out, /no effect on/);
  assert.doesNotMatch(out, /WARNING/);
  assert.doesNotMatch(out, /###/);
});

// 3. Unset is the overwhelmingly common case and runs on every boot. Both
//    builds must say nothing at all.
test('unset stays silent on a lean build', () => {
  assert.equal(runWarn('ANALYZER_HEAVY', null, leanVenv(createTempDir(join(tmp, 'lean-quiet-')))).trim(), '');
});
test('unset stays silent on a heavy build', () => {
  assert.equal(runWarn('ANALYZER_HEAVY', null, heavyVenv(createTempDir(join(tmp, 'heavy-quiet-')))).trim(), '');
});

// 4. An empty value is what `ANALYZER_HEAVY=` in a .env file yields, and it is
//    also what compose treats as unset (`${ANALYZER_HEAVY:+-heavy}` expands to
//    nothing). Warning there would contradict the compose semantics the
//    variable is named after.
test('empty value is treated as unset', () => {
  assert.equal(runWarn('ANALYZER_HEAVY', '', leanVenv(createTempDir(join(tmp, 'lean-empty-')))).trim(), '');
});

// 1. The trap case. Must warn, and must name ANALYZE_PYTHON — pointing the
//    operator back at ANALYZER_REPLICAS is the non-advice they already tried.
test('0 warns and names ANALYZE_PYTHON as the real off switch', () => {
  const out = runWarn('ANALYZER_REPLICAS', '0');
  assert.match(out, /WARNING: ANALYZER_REPLICAS=0 is set, and it does NOTHING/);
  assert.match(out, /ANALYZE_PYTHON/);
  // The specific misconception: they think they stopped paying for analysis.
  assert.match(out, /still running and still using RAM/);
  // The admin panel disagreeing with them is what makes this look like a bug.
  assert.match(out, /acoustic engine as ON/);
});

// 2. ANALYZE_URL is the other honest answer for an AIO operator who wants the
//    work to happen elsewhere, so the warning has to offer it rather than leave
//    "turn it off entirely" as the only exit.
test('the warning offers ANALYZE_URL for offloading', () => {
  assert.match(runWarn('ANALYZER_REPLICAS', '0'), /ANALYZE_URL/);
});

// 3. Asking for the analyzer to RUN is what an AIO already does. Inert, but the
//    outcome matches — a note, never the box.
test('1 notes without warning', () => {
  const out = runWarn('ANALYZER_REPLICAS', '1');
  assert.match(out, /no effect/);
  assert.doesNotMatch(out, /WARNING/);
  assert.doesNotMatch(out, /###/);
});

// 4. Values compose would REJECT (a fixed container_name forbids >1 replica, and
//    a non-integer is an interpolation error) still mean "run it" here. The AIO
//    must not adopt compose's hard failure — this is PID 1, and refusing to boot
//    over an inert variable would take the whole station down. Quiet note only.
test('2 is inert here and does not fail the boot', () => {
  const out = runWarn('ANALYZER_REPLICAS', '2');
  assert.match(out, /no effect/);
  assert.doesNotMatch(out, /WARNING/);
});
test('a non-integer is inert here and does not fail the boot', () => {
  const out = runWarn('ANALYZER_REPLICAS', 'false');
  assert.match(out, /no effect/);
  assert.doesNotMatch(out, /WARNING/);
});

// 5. Unset is the overwhelmingly common case and runs on every boot.
test('unset stays silent', () => {
  assert.equal(runWarn('ANALYZER_REPLICAS', null).trim(), '');
});

// 6. An empty value is what `ANALYZER_REPLICAS=` in a .env yields, and it is
//    what compose treats as unset (`${ANALYZER_REPLICAS:-1}` renders 1).
//    Warning there would contradict the compose semantics it is named after.
test('empty value is treated as unset', () => {
  assert.equal(runWarn('ANALYZER_REPLICAS', '').trim(), '');
});
