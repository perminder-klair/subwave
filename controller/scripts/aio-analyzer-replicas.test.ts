// Regression tests for the AIO supervisor's ANALYZER_REPLICAS warning
// (docker/aio/supervisor.sh: warn_if_analyzer_replicas_ignored).
//
// ANALYZER_REPLICAS=0 removes the compose `analyzer` SERVICE (#1570). The
// all-in-one image has no services — the analyzer is an in-process librosa venv
// the controller drives over stdio — so the variable is unreachable there, not
// merely unsupported. Same shape as ANALYZER_HEAVY (#1300 bug 9, see
// aio-analyzer-heavy.test.ts), and the reason this one needs its own warning
// rather than a docs line is that it fails WORSE: ANALYZER_HEAVY withholds a
// feature the operator asked for, while ANALYZER_REPLICAS=0 withholds nothing
// and silently keeps charging for it. The usual reason to set 0 is to stop
// paying for analysis; here analysis carries on holding RAM and CPU while the
// operator believes it is off, and the admin panel keeps reading "on", which
// looks like a broken switch rather than an absent one.
//
// The load-bearing properties:
//   1. `0`        -> a warning that names ANALYZE_PYTHON, the knob that actually
//      works here. Repeating ANALYZER_REPLICAS would be the same non-advice the
//      operator already followed.
//   2. non-zero   -> a note, not a warning. Still inert, but "run the analyzer"
//      is what an AIO does anyway, so the outcome already matches the request
//      and a scary box would send a fine setup chasing a non-problem.
//   3. unset/empty -> silence. This runs on every AIO boot.
//
// Run: `tsx scripts/aio-analyzer-replicas.test.ts`.
//
// node:assert-via-tsx style, matching scripts/aio-analyzer-heavy.test.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(here, '..', '..', 'docker', 'aio', 'supervisor.sh');

assert.ok(existsSync(SUPERVISOR), `supervisor.sh not found at ${SUPERVISOR}`);

// Drive warn_if_analyzer_replicas_ignored() by sourcing the supervisor in
// library mode. Returns the log lines the operator would see in `docker logs`.
// Unlike the ANALYZER_HEAVY warning there is no venv to probe: the AIO always
// analyses in-process, so the value alone decides the branch.
function runWarn(replicas: string | null): string {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (replicas === null) delete env.ANALYZER_REPLICAS;
  else env.ANALYZER_REPLICAS = replicas;
  return execFileSync(
    'bash',
    [
      '-c',
      `set -u; SUBWAVE_SUPERVISOR_LIB=1 source "$1"; warn_if_analyzer_replicas_ignored 2>&1`,
      'bash',
      SUPERVISOR,
    ],
    { env, encoding: 'utf8' },
  );
}

let failures = 0;

function scenario(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log('aio ANALYZER_REPLICAS warning');

// 1. The trap case. Must warn, and must name ANALYZE_PYTHON — pointing the
//    operator back at ANALYZER_REPLICAS is the non-advice they already tried.
scenario('0 warns and names ANALYZE_PYTHON as the real off switch', () => {
  const out = runWarn('0');
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
scenario('the warning offers ANALYZE_URL for offloading', () => {
  assert.match(runWarn('0'), /ANALYZE_URL/);
});

// 3. Asking for the analyzer to RUN is what an AIO already does. Inert, but the
//    outcome matches — a note, never the box.
scenario('1 notes without warning', () => {
  const out = runWarn('1');
  assert.match(out, /no effect/);
  assert.doesNotMatch(out, /WARNING/);
  assert.doesNotMatch(out, /###/);
});

// 4. Values compose would REJECT (a fixed container_name forbids >1 replica, and
//    a non-integer is an interpolation error) still mean "run it" here. The AIO
//    must not adopt compose's hard failure — this is PID 1, and refusing to boot
//    over an inert variable would take the whole station down. Quiet note only.
scenario('2 is inert here and does not fail the boot', () => {
  const out = runWarn('2');
  assert.match(out, /no effect/);
  assert.doesNotMatch(out, /WARNING/);
});
scenario('a non-integer is inert here and does not fail the boot', () => {
  const out = runWarn('false');
  assert.match(out, /no effect/);
  assert.doesNotMatch(out, /WARNING/);
});

// 5. Unset is the overwhelmingly common case and runs on every boot.
scenario('unset stays silent', () => {
  assert.equal(runWarn(null).trim(), '');
});

// 6. An empty value is what `ANALYZER_REPLICAS=` in a .env yields, and it is
//    what compose treats as unset (`${ANALYZER_REPLICAS:-1}` renders 1).
//    Warning there would contradict the compose semantics it is named after.
scenario('empty value is treated as unset', () => {
  assert.equal(runWarn('').trim(), '');
});

if (failures) {
  console.error(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
console.log('\nall scenarios passed');
