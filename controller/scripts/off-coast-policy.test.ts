// An untracked play checked against the coast the controller wrote (#2213):
// warn when the mixer airs a track from a file the controller replaced, and
// stay quiet for every untracked play that is legitimate.
// Run: `npm test -- off-coast-policy`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { coastContents } from '../src/broadcast/coast-handover.js';
import {
  ledgerAfterReload, ledgerAfterWrite, MAX_REPLACED_COASTS, offCoastVerdict, offCoastWarning, REPLACED_COAST_GRACE_MS,
  type CoastLedger,
} from '../src/broadcast/off-coast-policy.js';

const t = (id: string, artist = `Act ${id}`) => ({ id, title: `Song ${id}`, artist });
const empty: CoastLedger = { current: null, replaced: [] };
const T0 = 1_000_000;

// Two confirmed writes: the old show's file, then the new show's.
function twoShows() {
  const oldFile = coastContents([t('old1'), t('old2')], T0);
  const newFile = coastContents([t('new1'), t('new2')], T0 + 60_000);
  let ledger = ledgerAfterReload(ledgerAfterWrite(empty, oldFile, T0), oldFile, true);
  ledger = ledgerAfterReload(ledgerAfterWrite(ledger, newFile, T0 + 60_000), newFile, true);
  return { ledger, writtenAt: T0 + 60_000 };
}

const verdict = (ledger: CoastLedger, play: any, now: number, handedOverPending = false) =>
  offCoastVerdict({ play, ledger, handedOverPending, now });

test('a track from the replaced file, after the reload landed, warns', () => {
  const { ledger, writtenAt } = twoShows();
  assert.deepEqual(verdict(ledger, t('old2'), writtenAt + 5 * 60_000), { warn: true });
});

test('a track from nowhere the controller wrote warns', () => {
  const { ledger, writtenAt } = twoShows();
  assert.deepEqual(verdict(ledger, t('elsewhere'), writtenAt + 1_000), { warn: true });
});

test('a track in the current file is quiet, by id or by title|artist', () => {
  const { ledger, writtenAt } = twoShows();
  assert.deepEqual(verdict(ledger, t('new1'), writtenAt + 1_000), { warn: false, why: 'in-coast' });
  // A duplicate rip: another id, the same song.
  assert.deepEqual(verdict(ledger, { ...t('new2'), id: 'dupe' }, writtenAt + 1_000), { warn: false, why: 'in-coast' });
});

test('a track the mixer took from the replaced file before the reload is quiet inside the grace', () => {
  const { ledger, writtenAt } = twoShows();
  assert.deepEqual(verdict(ledger, t('old1'), writtenAt + REPLACED_COAST_GRACE_MS - 1), { warn: false, why: 'replaced-coast' });
  assert.deepEqual(verdict(ledger, t('old1'), writtenAt + REPLACED_COAST_GRACE_MS), { warn: true });
});

test('while the newest reload is unconfirmed or in flight, the replaced file stays the coast\'s', () => {
  const oldFile = coastContents([t('old1')], T0);
  const newFile = coastContents([t('new1')], T0 + 60_000);
  const confirmedOld = ledgerAfterReload(ledgerAfterWrite(empty, oldFile, T0), oldFile, true);
  const inFlight = ledgerAfterWrite(confirmedOld, newFile, T0 + 60_000);
  const late = T0 + 60_000 + 10 * REPLACED_COAST_GRACE_MS;
  assert.deepEqual(verdict(inFlight, t('old1'), late), { warn: false, why: 'replaced-coast' });
  const unconfirmed = ledgerAfterReload(inFlight, newFile, false);
  assert.deepEqual(verdict(unconfirmed, t('old1'), late), { warn: false, why: 'replaced-coast' });
  // A later write over an unconfirmed one keeps both older files.
  const third = coastContents([t('third1')], T0 + 120_000);
  const after3 = ledgerAfterReload(ledgerAfterWrite(unconfirmed, third, T0 + 120_000), third, true);
  const inGrace = T0 + 120_000 + 1_000;
  assert.deepEqual(verdict(after3, t('old1'), inGrace), { warn: false, why: 'replaced-coast' });
  assert.deepEqual(verdict(after3, t('new1'), inGrace), { warn: false, why: 'replaced-coast' });
  assert.deepEqual(verdict(after3, t('old1'), inGrace + REPLACED_COAST_GRACE_MS), { warn: true });
});

test('two confirmed writes inside one grace keep the file before both: its track can surface after the second', () => {
  // A show boundary's two refreshes, a second apart. The mixer took `old1` just
  // before the first reload; the controller sees it a poll later.
  const oldFile = coastContents([t('old1')], T0);
  const first = coastContents([t('new1')], T0 + 60_000);
  const second = coastContents([t('new2')], T0 + 61_000);
  let ledger = ledgerAfterReload(ledgerAfterWrite(empty, oldFile, T0), oldFile, true);
  ledger = ledgerAfterReload(ledgerAfterWrite(ledger, first, T0 + 60_000), first, true);
  ledger = ledgerAfterReload(ledgerAfterWrite(ledger, second, T0 + 61_000), second, true);
  assert.deepEqual(verdict(ledger, t('old1'), T0 + 61_500), { warn: false, why: 'replaced-coast' });
  assert.deepEqual(verdict(ledger, t('new1'), T0 + 61_500), { warn: false, why: 'replaced-coast' });
  // The grace runs from the newest write, and the merged files leave with it.
  assert.deepEqual(verdict(ledger, t('old1'), T0 + 61_000 + REPLACED_COAST_GRACE_MS), { warn: true });
  // A first write's unknown predecessor survives a quick second write too.
  let boot = ledgerAfterReload(ledgerAfterWrite(empty, first, T0), first, true);
  boot = ledgerAfterReload(ledgerAfterWrite(boot, second, T0 + 1_000), second, true);
  assert.deepEqual(verdict(boot, t('prior'), T0 + 1_500), { warn: false, why: 'replaced-coast' });
  // Past the grace, a confirmed write drops what came before the file it replaced.
  let spaced = ledgerAfterReload(ledgerAfterWrite(empty, oldFile, T0), oldFile, true);
  spaced = ledgerAfterReload(ledgerAfterWrite(spaced, first, T0 + 60_000), first, true);
  spaced = ledgerAfterReload(ledgerAfterWrite(spaced, second, T0 + 60_000 + REPLACED_COAST_GRACE_MS), second, true);
  assert.deepEqual(verdict(spaced, t('old1'), T0 + 60_000 + REPLACED_COAST_GRACE_MS + 1), { warn: true });
});

test('refreshes a few seconds apart never stretch the grace: a file replaced past it warns, and the ledger stays bounded', () => {
  // An hour of confirmed writes 3 s apart (an operator saving settings over and
  // over): each file's grace runs from its own replacement, not the newest write.
  const first = coastContents([t('first')], T0);
  let ledger = ledgerAfterReload(ledgerAfterWrite(empty, first, T0), first, true);
  let now = T0;
  for (let i = 1; i <= 1200; i++) {
    now = T0 + i * 3_000;
    const file = coastContents([t(`f${i}`)], now);
    ledger = ledgerAfterReload(ledgerAfterWrite(ledger, file, now), file, true);
    assert.ok(ledger.replaced.length <= MAX_REPLACED_COASTS, `write ${i}: ${ledger.replaced.length} kept`);
  }
  // The first write's unknown predecessor and the first file left long ago.
  assert.deepEqual(verdict(ledger, t('prior'), now + 500), { warn: true });
  assert.deepEqual(verdict(ledger, t('first'), now + 500), { warn: true });
  // The files replaced inside the last grace are still the coast's.
  assert.deepEqual(verdict(ledger, t('f1199'), now + 500), { warn: false, why: 'replaced-coast' });
  assert.deepEqual(verdict(ledger, t('f1196'), now + 500), { warn: false, why: 'replaced-coast' });
  assert.deepEqual(verdict(ledger, t('f1190'), now + 500), { warn: true });
});

test('a chain of unconfirmed reloads keeps at most MAX_REPLACED_COASTS files, the unknown predecessor included', () => {
  let ledger = empty;
  let now = T0;
  for (let i = 0; i <= MAX_REPLACED_COASTS; i++) {
    now = T0 + i * 60_000;
    const file = coastContents([t(`u${i}`)], now);
    ledger = ledgerAfterReload(ledgerAfterWrite(ledger, file, now), file, false);
  }
  assert.equal(ledger.replaced.length, MAX_REPLACED_COASTS);
  assert.deepEqual(verdict(ledger, t('prior'), now + 500), { warn: true });
  assert.deepEqual(verdict(ledger, t('u0'), now + 500), { warn: false, why: 'replaced-coast' });
});

test('a stale reload answer never confirms a newer write', () => {
  const a = coastContents([t('a')], T0);
  const b = coastContents([t('b')], T0 + 1);
  const ledger = ledgerAfterWrite(ledgerAfterWrite(empty, a, T0), b, T0 + 1);
  assert.equal(ledgerAfterReload(ledger, a, true), ledger);
});

test('with no coast written by this process, nothing warns', () => {
  assert.deepEqual(verdict(empty, t('x'), T0), { warn: false, why: 'no-coast' });
});

test('the first write replaced another process\'s file: any play is the coast\'s through its grace', () => {
  const first = coastContents([t('new1')], T0);
  const ledger = ledgerAfterReload(ledgerAfterWrite(empty, first, T0), first, true);
  assert.deepEqual(verdict(ledger, t('prior'), T0 + 1_000), { warn: false, why: 'replaced-coast' });
  assert.deepEqual(verdict(ledger, t('prior'), T0 + REPLACED_COAST_GRACE_MS), { warn: true });
  // Unconfirmed, it stays unknown for as long as that lasts.
  const unconfirmed = ledgerAfterReload(ledgerAfterWrite(empty, first, T0), first, false);
  assert.deepEqual(verdict(unconfirmed, t('prior'), T0 + 10 * REPLACED_COAST_GRACE_MS), { warn: false, why: 'replaced-coast' });
});

test('a DJ pick handed to the mixer and not yet matched is quiet', () => {
  const { ledger, writtenAt } = twoShows();
  assert.deepEqual(verdict(ledger, t('pick'), writtenAt + 5 * 60_000, true), { warn: false, why: 'handed-over' });
});

test('an unidentified play is quiet', () => {
  const { ledger, writtenAt } = twoShows();
  assert.deepEqual(verdict(ledger, { id: null, title: '' }, writtenAt + 5 * 60_000), { warn: false, why: 'unidentified' });
  assert.deepEqual(verdict(ledger, null, writtenAt + 5 * 60_000), { warn: false, why: 'unidentified' });
});

test('the warning names the track, the show and a strict playlist', () => {
  const line = offCoastWarning(t('old2', 'Artist B'), 'Show 2', true);
  assert.match(line, /"Song old2" — Artist B/);
  assert.match(line, /show "Show 2" \(strict playlist\)/);
  assert.match(line, /#2213/);
  assert.doesNotMatch(offCoastWarning(t('x'), null, false), /show "/);
});
