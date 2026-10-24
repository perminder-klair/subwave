// Pins the Library page's run-log merge (library/run-log.ts): every line of a
// run kept once, in order, a new run replacing the old, and the cap reported.
// Run from web/: `npm test -- run-log`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRunLog, orphanRunLog, type RunLogPage } from './run-log';

const page = (runId: string, seqs: number[], gap = false, closed = false): RunLogPage => ({
  runId,
  entries: seqs.map(seq => ({ seq, line: `line ${seq}` })),
  nextSeq: seqs.length ? seqs[seqs.length - 1]! : 0,
  gap,
  closed,
});
const seqsOf = (v: { entries: { seq: number }[] }) => v.entries.map(e => e.seq);

test('pages of one run append in order', () => {
  const a = mergeRunLog(null, page('r1', [1, 2, 3]));
  const b = mergeRunLog(a, page('r1', [4, 5]));
  assert.deepEqual(seqsOf(b), [1, 2, 3, 4, 5]);
  assert.equal(b.nextSeq, 5);
  assert.equal(b.gap, false);
});

test('a page that repeats lines already held never duplicates them', () => {
  const a = mergeRunLog(null, page('r1', [1, 2, 3]));
  const b = mergeRunLog(a, page('r1', [2, 3, 4]));
  assert.deepEqual(seqsOf(b), [1, 2, 3, 4]);
});

test('an empty page keeps the cursor where it was', () => {
  const a = mergeRunLog(null, page('r1', [1, 2]));
  const b = mergeRunLog(a, { runId: 'r1', entries: [], nextSeq: 2, gap: false, closed: false });
  assert.deepEqual(seqsOf(b), [1, 2]);
  assert.equal(b.nextSeq, 2);
});

test('a page from a new run replaces the old run', () => {
  const a = mergeRunLog(null, page('r1', [1, 2, 3]));
  const b = mergeRunLog(a, page('r2', [1]));
  assert.equal(b.runId, 'r2');
  assert.deepEqual(seqsOf(b), [1]);
  assert.equal(b.nextSeq, 1);
});

test('a gap reported by the controller stays reported for the run', () => {
  const a = mergeRunLog(null, page('r1', [4000, 4001], true));
  const b = mergeRunLog(a, page('r1', [4002]));
  assert.equal(b.gap, true);
  assert.equal(mergeRunLog(b, page('r2', [1])).gap, false, 'a new run starts clean');
});

test('the browser keeps the newest 5000 lines and says it dropped some', () => {
  const big = page('r1', Array.from({ length: 5003 }, (_, i) => i + 1));
  const v = mergeRunLog(null, big);
  assert.equal(v.entries.length, 5000);
  assert.equal(v.entries[0]!.seq, 4);
  assert.equal(v.nextSeq, 5003);
  assert.equal(v.gap, true);
});

test('the view follows the controller on whether the run\'s output is all in', () => {
  const a = mergeRunLog(null, page('r1', [1, 2]));
  assert.equal(a.closed, false);
  const b = mergeRunLog(a, page('r1', [3], false, true));
  assert.equal(b.closed, true, 'the last page after the pipes closed');
  assert.equal(mergeRunLog(b, page('r2', [1])).closed, false, 'a new run is open again');
});

test('a log the controller no longer holds reads as closed, so polling stops', () => {
  const a = mergeRunLog(null, page('r1', [1, 2]));
  const o = orphanRunLog(a);
  assert.equal(o?.closed, true);
  assert.deepEqual(o?.entries, a.entries, 'what was fetched stays on the page');
  assert.equal(orphanRunLog(null), null);
});
