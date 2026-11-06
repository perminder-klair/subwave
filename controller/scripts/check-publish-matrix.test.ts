// Pins the whole-matrix rules for publish-images.yml (#2265), which lint.yml
// runs through scripts/check-publish-matrix.ts. Each matrix job sees only its
// own entry, so "one primary per image" and "each floating tag on one entry"
// can only be checked across the matrix. Breaking either races two builds for
// one tag on a release: two primaries race for :latest, two owners of
// :pascal race for :pascal, and whichever job finishes last owns it.
//
// Run: `npm test -- check-publish-matrix`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkPublishMatrix, loadMatrix, WORKFLOW, type MatrixEntry } from './check-publish-matrix.js';

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
