// Pins the whole-matrix rules for publish-images.yml (#2265), which lint.yml
// runs through scripts/check-publish-matrix.ts. Each matrix job sees only its
// own entry, so "one primary per image" and "each floating tag on one entry"
// can only be checked across the matrix. Breaking either races two builds for
// one tag on a release: two primaries race for :latest, two owners of
// :pascal race for :pascal, and whichever job finishes last owns it. The two
// CUDA images must also agree tag for tag, or one card gets a different wheel
// on the AIO and on the split stack.
//
// Run: `npm test -- check-publish-matrix`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkPublishMatrix, loadMatrix, missingLockstepImages, WORKFLOW, type MatrixEntry } from './check-publish-matrix.js';

// Today's shape: a single-build image beside the two subwave-aio-cuda builds.
function matrix(): MatrixEntry[] {
  return [
    { image: 'subwave-aio' },
    {
      image: 'subwave-aio-cuda',
      cuda_family: 'cu128',
      primary: true,
      arch_tags: 'turing ampere ada hopper blackwell',
    },
    { image: 'subwave-aio-cuda', cuda_family: 'cu124', primary: false, arch_tags: 'maxwell pascal volta' },
  ];
}

test('the real publish-images.yml passes', () => {
  const include = loadMatrix(readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(checkPublishMatrix(include), []);
});

test("today's shape passes, and so does a third build with its own tags", () => {
  assert.deepEqual(checkPublishMatrix(matrix()), []);
  const withCu126 = matrix();
  withCu126[2].arch_tags = '';
  withCu126.push({ image: 'subwave-aio-cuda', cuda_family: 'cu126', primary: false, arch_tags: 'maxwell pascal volta' });
  assert.deepEqual(checkPublishMatrix(withCu126), []);
});

test('two primaries for one image fail', () => {
  const m = matrix();
  m[2].primary = true;
  assert.deepEqual(checkPublishMatrix(m), ['subwave-aio-cuda has 2 primary builds; exactly one takes :latest']);
});

test('a multi-build image with no primary fails', () => {
  const m = matrix();
  m[1].primary = false;
  assert.deepEqual(checkPublishMatrix(m), ['subwave-aio-cuda has 0 primary builds; exactly one takes :latest']);
});

test('a cuda_family build must say primary: true or false', () => {
  const m = matrix();
  delete m[2].primary;
  assert.deepEqual(checkPublishMatrix(m), ['subwave-aio-cuda [cu124] must set primary: true or false']);
  m[2].primary = 'yes';
  assert.deepEqual(checkPublishMatrix(m), ['subwave-aio-cuda [cu124] must set primary: true or false']);
});

test('every build of a multi-build image needs a cuda_family', () => {
  const m = matrix();
  delete m[2].cuda_family;
  delete m[2].primary;
  delete m[2].arch_tags;
  assert.deepEqual(checkPublishMatrix(m), [
    'subwave-aio-cuda has 2 builds, so each needs a cuda_family to name it',
    // With no cuda_family the entry reads as the image's only build, so primary.
    'subwave-aio-cuda has 2 primary builds; exactly one takes :latest',
  ]);
});

test('an architecture tag on two builds fails', () => {
  const m = matrix();
  m[1].arch_tags = 'pascal turing ampere ada hopper blackwell';
  assert.deepEqual(checkPublishMatrix(m), [
    'subwave-aio-cuda:pascal is on 2 builds (subwave-aio-cuda [cu128], subwave-aio-cuda [cu124]); each tag sits on exactly one',
  ]);
});

test("one build's cuda_family can't be another build's architecture tag", () => {
  const m = matrix();
  m[2].arch_tags = 'maxwell pascal volta cu128';
  assert.deepEqual(checkPublishMatrix(m), [
    'subwave-aio-cuda:cu128 is on 2 builds (subwave-aio-cuda [cu128], subwave-aio-cuda [cu124]); each tag sits on exactly one',
  ]);
});

test('two builds with the same cuda_family fail', () => {
  const m = matrix();
  m[2].cuda_family = 'cu128';
  assert.deepEqual(checkPublishMatrix(m), [
    'subwave-aio-cuda:cu128 is on 2 builds (subwave-aio-cuda [cu128], subwave-aio-cuda [cu128]); each tag sits on exactly one',
  ]);
});

test('arch_tags needs a cuda_family', () => {
  const m = matrix();
  m[0].arch_tags = 'turing';
  assert.deepEqual(checkPublishMatrix(m), ['subwave-aio: arch_tags needs a cuda_family']);
});

test('latest is never a build or architecture tag', () => {
  const m = matrix();
  m[2].arch_tags = 'maxwell pascal volta latest';
  assert.deepEqual(checkPublishMatrix(m), [
    "subwave-aio-cuda [cu124]: latest is the primary build's plain tag, never a build or architecture tag",
  ]);
});

test('an entry with no image fails', () => {
  assert.deepEqual(checkPublishMatrix([...matrix(), { cuda_family: 'cu126' }]), ['matrix entry 4 has no image']);
});

test('a workflow without the matrix fails instead of passing with nothing checked', () => {
  assert.throws(() => loadMatrix('jobs:\n  build:\n    runs-on: ubuntu-latest\n'), /no jobs\.build\.strategy\.matrix\.include/);
  assert.throws(() => loadMatrix('jobs:\n  build:\n    strategy:\n      matrix:\n        include: []\n'), /no jobs/);
});

// Both CUDA images, in lockstep: the analyzer's two builds mirror the AIO's.
function lockstep(): MatrixEntry[] {
  return [
    ...matrix(),
    {
      image: 'subwave-analyzer-cuda',
      cuda_family: 'cu128',
      primary: true,
      arch_tags: 'turing ampere ada hopper blackwell',
    },
    { image: 'subwave-analyzer-cuda', cuda_family: 'cu124', primary: false, arch_tags: 'maxwell pascal volta' },
  ];
}

test('both CUDA images with the same tags on the same builds pass', () => {
  assert.deepEqual(checkPublishMatrix(lockstep()), []);
});

test('a tag moved to another build in one CUDA image only fails', () => {
  const m = lockstep();
  m[3].arch_tags = 'pascal turing ampere ada hopper blackwell';
  m[4].arch_tags = 'maxwell volta';
  assert.deepEqual(checkPublishMatrix(m), [
    'subwave-aio-cuda:pascal is on cu124 but subwave-analyzer-cuda:pascal is on cu128; both CUDA images keep each tag on the same build',
  ]);
});

test('a tag one CUDA image carries and the other lacks fails', () => {
  const m = lockstep();
  m[4].arch_tags = 'maxwell pascal';
  assert.deepEqual(checkPublishMatrix(m), [
    'subwave-aio-cuda:volta has no subwave-analyzer-cuda:volta; both CUDA images carry the same tags',
  ]);
});

test('the two CUDA images must give :latest the same primary wheel', () => {
  const m = lockstep();
  m[3].primary = false;
  m[4].primary = true;
  assert.deepEqual(checkPublishMatrix(m), [
    'subwave-aio-cuda:latest is on cu128 but subwave-analyzer-cuda:latest is on cu124; both CUDA images keep each tag on the same build',
  ]);
});

test('a CUDA image left as one plain build is out of lockstep', () => {
  const m = [...matrix(), { image: 'subwave-analyzer-cuda' }];
  const errors = checkPublishMatrix(m);
  assert.ok(
    errors.includes('subwave-aio-cuda:pascal has no subwave-analyzer-cuda:pascal; both CUDA images carry the same tags'),
    errors.join('\n'),
  );
  assert.ok(errors.some((e) => e.startsWith('subwave-aio-cuda:latest is on cu128 but subwave-analyzer-cuda:latest')), errors.join('\n'));
});

test('moving one tag in one image of the real workflow fails the check', () => {
  const include = loadMatrix(readFileSync(WORKFLOW, 'utf8'));
  const analyzer = include.filter((e) => e.image === 'subwave-analyzer-cuda');
  const cu124 = analyzer.find((e) => e.cuda_family === 'cu124');
  const cu128 = analyzer.find((e) => e.cuda_family === 'cu128');
  assert.ok(cu124 && cu128, 'the real workflow has both analyzer builds');
  cu124.arch_tags = 'maxwell pascal';
  cu128.arch_tags = `volta ${String(cu128.arch_tags)}`;
  assert.deepEqual(checkPublishMatrix(include), [
    'subwave-aio-cuda:volta is on cu124 but subwave-analyzer-cuda:volta is on cu128; both CUDA images keep each tag on the same build',
  ]);
});

test('the real workflow builds both CUDA images, so the lockstep rule compares something', () => {
  const include = loadMatrix(readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(missingLockstepImages(include), []);
  const renamed = include.map((e) =>
    e.image === 'subwave-analyzer-cuda' ? { ...e, image: 'subwave-analyzer-gpu' } : e,
  );
  assert.deepEqual(checkPublishMatrix(renamed), [], 'rule 3 alone passes a renamed image');
  assert.deepEqual(missingLockstepImages(renamed), [
    "no subwave-analyzer-cuda build, so the CUDA images' lockstep (rule 3) compares nothing",
  ]);
});

// The analyze worker names a card's tag in its fallback warning from its own
// sm → tag table (_ARCH_TAGS in analyze_worker.py). A tag added to or renamed
// in the matrix, or in that table, alone would have the warning point
// operators at a tag that is never published.
function workerArchTags(source: string): string[] {
  const table = /^_ARCH_TAGS = \(\n([\s\S]*?)^\)/m.exec(source);
  assert.ok(table, 'analyze_worker.py has an _ARCH_TAGS table');
  return [...table[1].matchAll(/\(\(\d+, \d+\), "([a-z]+)"\)/g)].map((m) => m[1]);
}

test("the analyze worker's arch-tag table names exactly the published architecture tags", () => {
  const worker = readFileSync(join(import.meta.dirname, 'analyze_worker.py'), 'utf8');
  const fromWorker = workerArchTags(worker);
  const published = loadMatrix(readFileSync(WORKFLOW, 'utf8'))
    .filter((e) => e.image === 'subwave-analyzer-cuda')
    .flatMap((e) => String(e.arch_tags ?? '').split(/\s+/).filter(Boolean));
  assert.ok(fromWorker.length > 0, 'the table parsed');
  assert.deepEqual([...fromWorker].sort(), [...published].sort());
});
