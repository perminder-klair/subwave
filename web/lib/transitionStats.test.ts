import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countRows,
  dropReasonLabel,
  effectLabel,
  formatDrop,
  formatDrops,
  historySeamLine,
  effectSeamCount,
  reasonSummary,
} from './transitionStats';

test('effectLabel capitalises an ask to match the seam labels', () => {
  assert.equal(effectLabel('sweep'), 'Sweep');
  assert.equal(effectLabel('normal'), 'Normal');
  assert.equal(effectLabel(''), '');
});

test('dropReasonLabel labels a known code and passes an unknown one through', () => {
  assert.equal(dropReasonLabel('pair-fit'), 'Pair did not suit it');
  assert.equal(dropReasonLabel('jingle-seam'), 'Jingle in between');
  assert.equal(dropReasonLabel('from-a-newer-controller'), 'from-a-newer-controller');
  // An inherited Object key is not a reason.
  assert.equal(dropReasonLabel('toString'), 'toString');
});

test('countRows sorts largest first, ties by label, and drops empty entries', () => {
  assert.deepEqual(
    countRows({ Sweep: 3, Normal: 40, Blend: 3, Chop: 0, Loop: undefined }),
    [
      { label: 'Normal', count: 40 },
      { label: 'Blend', count: 3 },
      { label: 'Sweep', count: 3 },
    ],
  );
  assert.deepEqual(countRows(null), []);
  assert.deepEqual(countRows({ variety: 2 }, dropReasonLabel), [{ label: 'Repeat rule', count: 2 }]);
});

test('reasonSummary reads one effect\'s reasons as a short line', () => {
  assert.equal(reasonSummary({ variety: 2, 'pair-fit': 8 }), 'Pair did not suit it 8 · Repeat rule 2');
  assert.equal(reasonSummary(undefined), '');
});

test('formatDrops names each drop, marks the auto washout, and is null when empty', () => {
  assert.equal(formatDrop({ effect: 'sweep', reason: 'pair-fit' }), 'Sweep dropped: Pair did not suit it');
  assert.equal(
    formatDrops([
      { effect: 'sweep', reason: 'variety' },
      { effect: 'washout', reason: 'show-boundary', auto: true },
    ]),
    'Sweep dropped: Repeat rule · Washout (auto) dropped: Show change cut',
  );
  assert.equal(formatDrops([]), null);
  assert.equal(formatDrops(null), null);
});

test('historySeamLine stays silent for legacy rows and plain seams with nothing dropped', () => {
  assert.equal(historySeamLine({}), null);
  assert.equal(historySeamLine({ transition: null, transitionAsk: null, transitionDrops: null }), null);
  assert.equal(historySeamLine({ transition: 'Normal', transitionAsk: 'normal', transitionDrops: [] }), null);
});

test('historySeamLine names the effect seam and any drops, with the ask in the hover', () => {
  assert.deepEqual(
    historySeamLine({ transition: 'Washout + Sweep', transitionAsk: 'sweep', transitionDrops: null }),
    { text: 'in on Washout + Sweep', title: 'Came in on: Washout + Sweep\nDJ asked for: Sweep' },
  );
  assert.deepEqual(
    historySeamLine({ transition: 'Normal', transitionAsk: 'chop', transitionDrops: [{ effect: 'chop', reason: 'jingle-seam' }] }),
    {
      text: 'Chop dropped: Jingle in between',
      title: 'Came in on a plain crossfade\nDJ asked for: Chop\nChop dropped: Jingle in between',
    },
  );
});

test('historySeamLine reads an interposed clip as what came before the song', () => {
  assert.deepEqual(
    historySeamLine({ transition: 'After jingle', transitionAsk: 'sweep', transitionDrops: [{ effect: 'sweep', reason: 'jingle-seam' }] }),
    {
      text: 'after a jingle · Sweep dropped: Jingle in between',
      title: 'Came in after a jingle\nDJ asked for: Sweep\nSweep dropped: Jingle in between',
    },
  );
  assert.deepEqual(
    historySeamLine({ transition: 'After bed', transitionAsk: null, transitionDrops: null }),
    { text: 'after a bed', title: 'Came in after a bed' },
  );
});

test('effectSeamCount counts only seams that carried an effect', () => {
  assert.equal(effectSeamCount({ Normal: 10, Sweep: 3, 'Washout + Sweep': 1, 'Stem blend': 2, 'After jingle': 4, 'After bed': 1 }), 6);
  assert.equal(effectSeamCount({ Normal: 5 }), 0);
  assert.equal(effectSeamCount(null), 0);
});
