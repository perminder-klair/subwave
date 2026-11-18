// An untracked play checked against the coast the controller wrote (#2213):
// warn when the mixer airs a track from a file the controller replaced, and
// stay quiet for every untracked play that is legitimate.
// Run: `npm test -- off-coast-policy`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { coastContents } from '../src/broadcast/coast-handover.js';
import {
  ledgerAfterReload, ledgerAfterWrite, offCoastVerdict, offCoastWarning, REPLACED_COAST_GRACE_MS,
  type CoastLedger,
} from '../src/broadcast/off-coast-policy.js';

const t = (id: string, artist = `Act ${id}`) => ({ id, title: `Song ${id}`, artist });
const empty: CoastLedger = { current: null, replaced: null, replacedUntil: 0 };
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
