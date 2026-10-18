// One act spelled with a hyphen or dash in one credit and a space in
// another is the same act to the SPACING keys (recency.artistRootKey).
//
// Seen on air 10 Oct: SCSI-9 "Storm" (album Sputnik 1), then SCSI 9 "Elegia"
// (The Line Of Nine), back to back. Navidrome credits the act with a hyphen on
// one album and a space on the other, so the keys differed and neither the
// agent's artist guard nor the pool picker's spacing saw a repeat.
//
// The fold is a MATCHING widening, so it must stay out of the blocklist's
// fold (nameKey / artistParticipantKeys): that list is absolute, with no
// never-starve behind it.
// Run: `tsx --test scripts/artist-key-separators.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artistCreditsOverlap,
  artistParticipantKeys,
  artistRootKey,
  filterPickerCandidates,
  nameKey,
} from '../src/music/recency.js';
import { alternativeCandidates, artistGuardCause } from '../src/broadcast/dj-agent/artist-guard.js';

const k = (artist: string) => artistRootKey(artist);

test('a hyphen or dash inside a name keys like a space', () => {
  const same: [string, string][] = [
    ['SCSI-9', 'SCSI 9'],
    ['Jay-Z', 'Jay Z'],
    ['A-ha', 'a ha'],
    ['Jean-Michel Jarre', 'Jean Michel Jarre'],
    ['SCSI–9', 'SCSI 9'], // en dash
    ['SCSI‐9', 'SCSI 9'], // U+2010 hyphen
    ['SCSI‑9', 'SCSI 9'], // U+2011 non-breaking hyphen
    ['SCSI‒9', 'SCSI 9'], // U+2012 figure dash
    ['Χάρη-Αλεξίου', 'Χάρη Αλεξίου'],
    // The fold runs before the article strip, so a hyphenated article goes too.
    ['The-Dream', 'The Dream'],
    ['The‐Dream', 'The Dream'], // U+2010, MusicBrainz's spelling
  ];
  for (const [a, b] of same) {
    assert.equal(k(a), k(b), `${a} vs ${b}`);
    assert.equal(artistCreditsOverlap(k(a), k(b)), true, `${a} vs ${b} overlap`);
  }
  assert.equal(k('The-Dream'), 'dream');
  // A single-act key re-keys to itself.
  for (const name of ['The-Dream', 'SCSI-9', 'Jay-Z', 'A-ha']) assert.equal(k(k(name)), k(name), name);
});

test('separators that are not inside a word are left alone', () => {
  // " - " between two credits, "/" in AC/DC, dots in initialisms, a leading dash.
  assert.equal(k('Artist A - Artist B'), 'artist a - artist b');
  assert.equal(k('AC/DC'), 'ac/dc');
  assert.equal(k('R.E.M.'), 'r.e.m.');
  assert.equal(k('M.I.A.'), 'm.i.a.');
  assert.equal(k('-M-'), '-m-');
  // The feat. split still sees its dot: the lead keys alone.
  assert.equal(k('Kanye West ft. Jay-Z'), 'kanye west');
});

test('names that only share letters still key apart', () => {
  const apart: [string, string][] = [
    ['Jay', 'Jay-Z'],
    ['M', 'M.I.A.'],
    ['SCSI-9', 'SCSI-90'],
    ['A-ha', 'Aha'],
  ];
  for (const [a, b] of apart) assert.equal(artistCreditsOverlap(k(a), k(b)), false, `${a} vs ${b}`);
});

test('the production case: the agent guard and the pool picker catch SCSI 9 after SCSI-9', () => {
  // Spacing window holding the track just played.
  assert.equal(artistGuardCause(k('SCSI 9'), k('Phillip Boa'), new Set([k('SCSI-9')])), 'recent');
  // The production call shape: no anchor, the raw credit as pickCredit.
  assert.equal(artistGuardCause(k('SCSI 9'), '', new Set([k('SCSI-9')]), 'SCSI 9'), 'recent');
  // Pick anchor: the on-air track itself.
  assert.equal(artistGuardCause(k('SCSI 9'), k('SCSI-9'), new Set()), 'onair');
  // The guard's re-pick set drops the other spelling too.
  const seen = new Map([
    ['a', { id: 'a', title: 'Elegia', artist: 'SCSI 9' }],
    ['b', { id: 'b', title: 'Lavender', artist: '50 Foot Wave' }],
  ]);
  assert.deepEqual([...alternativeCandidates(seen, k('SCSI-9'), new Set()).alt.keys()], ['b']);
  // Pool picker spacing.
  const out = filterPickerCandidates(
    [
      { id: 'a', title: 'Elegia', artist: 'SCSI 9' },
      { id: 'b', title: 'Lavender', artist: '50 Foot Wave' },
    ],
    { recentArtistRoots: new Set([k('SCSI-9')]), cap: 18 },
  );
  assert.deepEqual(out.map((c) => c.id), ['b']);
});

test('the blocklist fold does not widen', () => {
  // nameKey and artistParticipantKeys key the ABSOLUTE never-play list: a
  // block on "SCSI-9" must not start removing a differently spelled credit.
  assert.equal(nameKey('SCSI-9'), 'scsi-9');
  assert.notEqual(nameKey('SCSI-9'), nameKey('SCSI 9'));
  assert.deepEqual(artistParticipantKeys('SCSI-9'), ['scsi-9']);
  assert.deepEqual(artistParticipantKeys('Kanye West (feat. Jay-Z)'), ['kanye west', 'jay-z']);
});
