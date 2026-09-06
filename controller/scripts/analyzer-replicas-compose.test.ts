// Drift guard for the analyzer off switch (#1570) across the three composes.
//
// `ANALYZER_REPLICAS=0` removes the local analyzer container, and it is spelled
// the same way in docker-compose.yml, docker-compose.byo.yml and
// docker-compose.dev.yml: `deploy.replicas: ${ANALYZER_REPLICAS:-1}` on the
// `analyzer` service. Three copies of one decision is exactly the shape the
// repo already drives from one table elsewhere (max-listeners, state-bootstrap)
// — fix one, fix all three — so this pins them from one table too.
//
// The properties that make the switch work, and how each one breaks:
//   1. All three files carry the line. Miss one and the off switch silently
//      does nothing for whichever deployment shape that file serves — the byo
//      and dev operators are the ones who would never notice in review.
//   2. The default is `:-1`, not `:-0` and not a bare `${ANALYZER_REPLICAS}`.
//      This is the "absent or malformed settings must coerce to the
//      pre-existing behaviour" rule in CLAUDE.md: unset and empty both have to
//      render 1, so an upgrade is byte-identical for every existing install.
//      `:-` (not `-`) is what makes EMPTY behave like unset, which is what a
//      bare `ANALYZER_REPLICAS=` line in a .env produces.
//   3. `container_name` stays pinned, which is why only 0 and 1 are valid:
//      compose refuses a fixed container name for more than one replica, so a
//      future edit that drops container_name to "allow scaling" would quietly
//      change what the documented values mean.
//   4. The `deploy` block holds ONLY replicas here. The GPU overlay
//      (docker-compose.analyzer-gpu.yml) merges its own `deploy.resources` in
//      key-wise; putting resources in the base `deploy` too is how that merge
//      starts producing a surprise.
//
// Text-level assertions on purpose: this is about what the FILES say, and a
// YAML parse would happily normalise away the `:-1` that property 2 is about.
//
// Run: `tsx scripts/analyzer-replicas-compose.test.ts` (or `npm test -- analyzer-replicas`).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

// The one table. Every compose file that ships an `analyzer` service belongs
// here; adding a fourth deployment shape means adding a row, not a new test.
const COMPOSES = ['docker-compose.yml', 'docker-compose.byo.yml', 'docker-compose.dev.yml'] as const;

const GPU_OVERLAY = 'docker-compose.analyzer-gpu.yml';

function read(name: string): string {
  return readFileSync(join(ROOT, name), 'utf8');
}

// The `analyzer:` service block — from its key to the next top-level service or
// the `volumes:` stanza. Scoping matters: `deploy:` appears on other services,
// and a test that matched the whole file would pass on a line that landed under
// the wrong one.
function analyzerBlock(src: string): string {
  const start = src.indexOf('\n  analyzer:\n');
  assert.notEqual(start, -1, 'no `analyzer:` service found');
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n|\nvolumes:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

for (const file of COMPOSES) {
  test(`${file}: analyzer replicas render from ANALYZER_REPLICAS, defaulting to 1`, () => {
    const block = analyzerBlock(read(file));

    // 1 + 2. The exact interpolation. `:-1` is load-bearing twice over: the
    // default keeps an unset var at the pre-change station, and the colon is
    // what extends that to an empty value.
    assert.match(
      block,
      /^\s*deploy:\n\s*replicas: \$\{ANALYZER_REPLICAS:-1\}$/m,
      'expected `deploy:` / `replicas: ${ANALYZER_REPLICAS:-1}` on the analyzer service',
    );

    // The two ways to get this subtly wrong and still look right in a diff.
    assert.doesNotMatch(block, /\$\{ANALYZER_REPLICAS-1\}/, 'must use `:-` so an EMPTY value also renders 1');
    assert.doesNotMatch(block, /\$\{ANALYZER_REPLICAS\}/, 'must carry a default: a bare var renders empty and breaks the service');
    assert.doesNotMatch(block, /\$\{ANALYZER_REPLICAS:-0\}/, 'the default must be 1 — 0 would turn the analyzer off for every existing install');

    // 3. Only 0 and 1 are valid because the container name is fixed. If this
    // ever goes, the documented "0 or 1 only" caveat needs to go with it.
    assert.match(block, /^\s*container_name: sub-wave-analyzer$/m, 'container_name is what limits the switch to 0/1');

    // 4. Keep the base `deploy` to replicas alone so the GPU overlay's
    // `deploy.resources` merges in rather than colliding.
    const deploy = block.slice(block.indexOf('deploy:'));
    assert.doesNotMatch(
      deploy.slice(0, deploy.indexOf('\n    restart:') + 1),
      /resources:/,
      'base `deploy` should hold only replicas; resources belong to the GPU overlay',
    );
  });
}

test('the GPU overlay contributes deploy.resources, so the merge stays key-wise', () => {
  // The claim this pins: `-f docker-compose.yml -f docker-compose.analyzer-gpu.yml`
  // yields BOTH `replicas` and the nvidia reservation. Compose merges mappings
  // key-wise, so that holds as long as the two files put different keys under
  // `deploy` — which is what this asserts, without needing docker present.
  const overlay = analyzerBlock(read(GPU_OVERLAY));
  assert.match(overlay, /deploy:/, 'overlay should still carry a deploy block');
  assert.match(overlay, /resources:/, 'overlay should contribute deploy.resources');
  assert.doesNotMatch(overlay, /replicas:/, 'overlay must not restate replicas, or it would override the off switch');
});

test('every compose that defines an analyzer service is in the table', () => {
  // Stops a fourth deployment shape from shipping the service without the
  // switch. Mirrors the source list in cli/scripts/embed-assets.ts.
  const withAnalyzer = readdirSync(ROOT)
    .filter((f) => /^docker-compose.*\.yml$/.test(f))
    .filter((f) => read(f).includes('\n  analyzer:\n'))
    // The GPU file is an overlay: it patches the service rather than defining
    // the deployment, so it carries resources and not the replica count.
    .filter((f) => f !== GPU_OVERLAY);
  assert.deepEqual(withAnalyzer.sort(), [...COMPOSES].sort());
});
