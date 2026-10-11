// Artist spacing across multi-artist credits, whatever joins them.
//
// Music servers credit several artists in one string with whatever separator
// their scanner or tagger chose: Navidrome " • ", others " / ", "; ", ", ".
// The spacing keys (recency.artistRootKey) only split feat./ft./featuring and
// a lead "&"/"+"/"and" join, so "Pixies • Black Francis" keyed as one act and
// aired right after "Pixies" (production, 8 Oct 2026). The fix names no
// separator: any character that cannot be part of a name delimits two acts,
// and one credit matching a delimited act inside the other counts as the same
// artist, on the agent guard and on the pool picker's spacing alike.
// Run: `tsx --test scripts/artist-credit-overlap.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artistCreditsOverlap,
  artistRootIn,
  artistRootKey,
  filterPickerCandidates,
} from '../src/music/recency.js';
import { alternativeCandidates, artistGuardCause } from '../src/broadcast/dj-agent/artist-guard.js';
import { alternativeAlbumCandidates } from '../src/broadcast/dj-agent/album-guard.js';

const k = (artist: string) => artistRootKey(artist);

test('a delimited act inside a credit matches, whatever the separator', () => {
  for (const credit of [
    'Pixies • Black Francis',
    'Black Francis • Pixies',
    'Pixies / Black Francis',
    'Black Francis; Pixies',
    'Black Francis, Pixies',
    'Pixies | Black Francis',
    'Pixies · Black Francis',
    'Pixies ★ Black Francis', // a separator nobody wrote a rule for
  ]) {
    assert.equal(artistCreditsOverlap(k('Pixies'), k(credit)), true, credit);
    assert.equal(artistCreditsOverlap(k(credit), k('Pixies')), true, `${credit} (either order)`);
  }
});

test('a name that only shares words is not the same act', () => {
  const pairs: [string, string][] = [
    ['Air', 'Air Supply'],
    ['Simon', 'Paul Simon'],
    ['Pixies', 'Pixiesque'],
    ['Black', 'Black Francis • Pixies'], // "black" is not delimited from "francis"
    ['Kanye West', 'Kanye Westside'],
  ];
  for (const [a, b] of pairs) assert.equal(artistCreditsOverlap(k(a), k(b)), false, `${a} vs ${b}`);
});

test('the marks names carry are not separators', () => {
  assert.equal(artistCreditsOverlap(k('R.E.M.'), k('R.E.M. • Michael Stipe')), true);
  assert.equal(artistCreditsOverlap(k('M'), k('M.I.A.')), false);
  assert.equal(artistCreditsOverlap(k('Jay'), k('Jay-Z')), false);
  assert.equal(artistCreditsOverlap(k("Guns N' Roses"), k("Guns N' Roses • Slash")), true);
  assert.equal(artistCreditsOverlap(k('Guns N'), k("Guns N' Roses")), false);
  // "&" and "+" sit inside band names: "X & the Y" stays one act.
  assert.equal(artistCreditsOverlap(k('Sly & Robbie'), k('Sly & the Family Stone')), false);
  assert.equal(artistCreditsOverlap(k('Florence'), k('Florence + the Machine')), false);
});

test('single-letter and non-Latin acts', () => {
  assert.equal(artistCreditsOverlap(k('X'), k('X • John Doe')), true);
  assert.equal(artistCreditsOverlap(k('X'), k('XTC')), false);
  assert.equal(artistCreditsOverlap(k('Χάρης Αλεξίου'), k('Χάρης Αλεξίου • Μάνος Χατζιδάκις')), true);
  assert.equal(artistCreditsOverlap(k('Χάρης'), k('Χάρης Αλεξίου')), false);
});

test('empty keys never match', () => {
  assert.equal(artistCreditsOverlap('', 'pixies'), false);
  assert.equal(artistRootIn('', new Set(['pixies'])), false);
  assert.equal(artistRootIn('pixies', new Set()), false);
});

test('the agent guard catches a multi-artist credit after its act (production case)', () => {
  // Spacing window holding the track just played.
  assert.equal(artistGuardCause(k('Pixies • Black Francis'), k('Phillip Boa'), new Set([k('Pixies')])), 'recent');
  // Pick anchor: the on-air track itself.
  assert.equal(artistGuardCause(k('Pixies • Black Francis'), k('Pixies'), new Set()), 'onair');
  assert.equal(artistGuardCause(k('Black Francis • Pixies'), k('Pixies'), new Set()), 'onair');
  // Unrelated acts still pass.
  assert.equal(artistGuardCause(k('50 Foot Wave'), k('Pixies'), new Set([k('Pixies')])), null);
});

test("the guard's re-pick set drops every credit naming the rejected act", () => {
  const seen = new Map([
    ['a', { id: 'a', title: 'Mr. Grieves', artist: 'Pixies • Black Francis' }],
    ['b', { id: 'b', title: 'Lavender', artist: '50 Foot Wave' }],
    ['c', { id: 'c', title: 'Velvety', artist: 'Black Francis / Pixies' }],
  ]);
  const { alt } = alternativeCandidates(seen, k('Pixies'), new Set());
  assert.deepEqual([...alt.keys()], ['b']);
});

test("the pool picker's spacing filters multi-artist credits too", () => {
  const candidates = [
    { id: 'a', title: 'Mr. Grieves', artist: 'Pixies • Black Francis' },
    { id: 'b', title: 'Lavender', artist: '50 Foot Wave' },
  ];
  const out = filterPickerCandidates(candidates, { recentArtistRoots: new Set([k('Pixies')]), cap: 18 });
  assert.deepEqual(out.map((c) => c.id), ['b']);
});

test("the album guard's re-pick steps around a neighbouring act inside a credit", () => {
  const seen = new Map([
    ['a', { id: 'a', title: 'Mr. Grieves', artist: 'Pixies • Black Francis', album: 'Doolittle' }],
    ['b', { id: 'b', title: 'Lavender', artist: '50 Foot Wave', album: '50 Foot Wave EP' }],
  ]);
  const { alt } = alternativeAlbumCandidates(seen, new Set(), (s) => s.album ?? '', new Set([k('Pixies')]));
  assert.deepEqual([...alt.keys()], ['b']);
});
