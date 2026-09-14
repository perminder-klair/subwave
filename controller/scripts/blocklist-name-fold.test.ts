// #1611: the blocklist's artist tier, album tier and rule matcher must fold a
// name the same way. The list is absolute (no never-starve, requests included),
// so folding two DIFFERENT names together removes music nobody blocked.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time, so every
// src import below is dynamic.
const stateDir = mkdtempSync(join(tmpdir(), 'blocklist-fold-test-'));
process.env.STATE_DIR = stateDir;

const { artistNameKey, nameKey } = await import('../src/music/recency.js');
const { compileRules, ruleMatches, normText, validateRulePatch } = await import('../src/music/blocklist-rules.js');
type BlockRule = import('../src/music/blocklist-rules.js').BlockRule;
const blocklist = await import('../src/music/blocklist.js');

// The apostrophe shapes `recency.APOSTROPHES` folds onto the straight quote.
const CURLY = ['Guns N’ Roses', 'Guns N‘ Roses', 'Guns Nʼ Roses', 'Guns N´ Roses', 'Guns N` Roses'];
const STRAIGHT = "Guns N' Roses";

test('nameKey and artistNameKey are one function', () => {
  // Two functions here means the album and artist tiers can disagree again.
  assert.equal(nameKey, artistNameKey);
});

test('schemas/blocklist normText restates nameKey exactly', () => {
  // A mirrored schema module may import only zod, so normText restates the
  // fold rather than importing it. Pin the restatement against the original.
  const cases = [
    ...CURLY,
    STRAIGHT,
    '  Chinese   Democracy  ',
    'SGT. PEPPER’S LONELY HEARTS CLUB BAND',
    'Livin’ La Vida Loca',
    'Rock ’n’ Roll',
    'trip-hop',
    'trip hop',
    '',
    '   ',
    'AC/DC',
    'Sunn O)))',
    '’',
  ];
  for (const raw of cases) {
    assert.equal(normText(raw), nameKey(raw), JSON.stringify(raw));
  }
  // Non-string shapes both readers meet: a null album, an absent field.
  for (const raw of [null, undefined]) {
    assert.equal(normText(raw), nameKey(raw), String(raw));
  }
});

test('the fold folds apostrophe style and nothing else about the name', () => {
  for (const curly of CURLY) {
    assert.equal(nameKey(curly), "guns n' roses", curly);
  }
  // Other punctuation is not folded: `trip-hop` is its own tag.
  assert.notEqual(nameKey('trip-hop'), nameKey('trip hop'));
  assert.notEqual(nameKey('AC/DC'), nameKey('AC DC'));
  // A fold never empties or renames: "Sunn O)))" is a band, not brackets.
  assert.equal(nameKey('Sunn O)))'), 'sunn o)))');
});

test('an album entry blocks the apostrophe variant of the same row', async () => {
  await blocklist.load();
  // Stored the way POST /library/blocklist persists it: display snapshots off
  // the blocked row, curly apostrophe and all.
  await blocklist.add({
    type: 'album',
    id: 'alb-cd',
    name: 'Chinese Democracy',
    artist: 'Guns N’ Roses',
  });

  assert.equal(
    blocklist.isBlocked({ id: 's1', album: 'Chinese Democracy', artist: STRAIGHT }),
    true,
    'a straight-apostrophe credit must hit a curly-apostrophe entry',
  );
  for (const curly of CURLY) {
    assert.equal(
      blocklist.isBlocked({ id: 's2', album: 'Chinese Democracy', artist: curly }),
      true,
      curly,
    );
  }
  // Case and whitespace still fold too.
  assert.equal(
    blocklist.isBlocked({ id: 's3', album: '  chinese   democracy ', artist: STRAIGHT }),
    true,
  );

  // The badge names the entry that caused the hit, so the operator can
  // unblock exactly that one.
  assert.deepEqual(
    blocklist.hitOf({ id: 's4', album: 'Chinese Democracy', artist: STRAIGHT }),
    { kind: 'entry', type: 'album', id: 'alb-cd', name: 'Chinese Democracy' },
  );

  await blocklist.remove('album', 'alb-cd');
});

test('the ALBUM half of the key folds too, not just the artist half', async () => {
  // Straight apostrophe in the TITLE this time: the half an artist-only fix
  // would miss.
  await blocklist.add({
    type: 'album',
    id: 'alb-sgt',
    name: "Sgt. Pepper's Lonely Hearts Club Band",
    artist: 'The Beatles',
  });
  assert.equal(
    blocklist.isBlocked({ id: 'b1', album: 'Sgt. Pepper’s Lonely Hearts Club Band', artist: 'The Beatles' }),
    true,
    'a curly-apostrophe album title must hit a straight-apostrophe entry',
  );
  await blocklist.add({
    type: 'album',
    id: 'alb-lav',
    name: 'Livin’ La Vida Loca',
    artist: 'Ricky Martin',
  });
  assert.equal(
    blocklist.isBlocked({ id: 'b2', album: "Livin' La Vida Loca", artist: 'Ricky Martin' }),
    true,
  );

  await blocklist.remove('album', 'alb-sgt');
  await blocklist.remove('album', 'alb-lav');
});

test('the album tier answers the artist half exactly as the artist tier does', async () => {
  // Only ONE entry is in the list at a time: matchOf answers artist-tier
  // before album-tier, so an artist entry left in place claims every row here
  // and the album half is never reached.
  const spellings = [...CURLY, STRAIGHT, '  GUNS   N’ ROSES  ', 'Guns And Roses'];

  await blocklist.add({ type: 'artist', id: 'art-gnr', name: STRAIGHT });
  const artistTier = spellings.map((s) => blocklist.isBlocked({ id: 'p1', artist: s }));
  await blocklist.remove('artist', 'art-gnr');

  await blocklist.add({ type: 'album', id: 'alb-au', name: 'Appetite for Destruction', artist: STRAIGHT });
  const albumTier = spellings.map((s) =>
    blocklist.isBlocked({ id: 'p2', album: 'Appetite for Destruction', artist: s }));
  await blocklist.remove('album', 'alb-au');

  for (const [i, spelling] of spellings.entries()) {
    const sameAct = artistNameKey(spelling) === artistNameKey(STRAIGHT);
    assert.equal(artistTier[i], sameAct, `artist tier: ${spelling}`);
    assert.equal(albumTier[i], sameAct, `album tier: ${spelling}`);
  }
});

test('the widening stops at the apostrophe — the pair is still a pair', async () => {
  // The artist half of the key stops a generic title cross-matching another
  // artist's album.
  await blocklist.add({ type: 'album', id: 'alb-gh', name: 'Greatest Hits', artist: 'Queen' });

  assert.equal(blocklist.isBlocked({ id: 'n1', album: 'Greatest Hits', artist: 'Queen' }), true);
  assert.equal(
    blocklist.isBlocked({ id: 'n2', album: 'Greatest Hits', artist: 'Abba' }),
    false,
    "another artist's Greatest Hits must stay playable",
  );
  // No substring match crept in with the fold.
  assert.equal(blocklist.isBlocked({ id: 'n3', album: 'Greatest Hits Vol. 2', artist: 'Queen' }), false);
  assert.equal(blocklist.isBlocked({ id: 'n4', album: 'Greatest Hits', artist: 'Queen Latifah' }), false);
  // A row with no album reaches no album key at all.
  assert.equal(blocklist.isBlocked({ id: 'n5', artist: 'Queen' }), false);
  // The NUL separator keeps ("a b", "c") apart from ("a", "b c").
  await blocklist.add({ type: 'album', id: 'alb-sep', name: 'a b', artist: 'c' });
  assert.equal(blocklist.isBlocked({ id: 'n6', album: 'a', artist: 'b c' }), false);

  await blocklist.remove('album', 'alb-gh');
  await blocklist.remove('album', 'alb-sep');
});

const ruleOf = (field: BlockRule['field'], values: string[]): BlockRule => ({
  id: 'r1', label: 'Blocked', field, values,
  season: null, showIds: [], addedAt: '2026-01-01T00:00:00.000Z',
});

test('a field:album rule folds apostrophes the way an album entry does', () => {
  const curly = compileRules([ruleOf('album', ['Chinese Democracy'])])[0]!;
  assert.equal(ruleMatches(curly, { album: 'Chinese Democracy' }, null), true);

  const sgt = compileRules([ruleOf('album', ["Sgt. Pepper's Lonely Hearts Club Band"])])[0]!;
  assert.equal(
    ruleMatches(sgt, { album: 'Sgt. Pepper’s Lonely Hearts Club Band' }, null),
    true,
    'a value typed with a straight quote must match a catalogue tagged curly',
  );
  const sgtCurly = compileRules([ruleOf('album', ['Sgt. Pepper’s Lonely Hearts Club Band'])])[0]!;
  assert.equal(ruleMatches(sgtCurly, { album: "Sgt. Pepper's Lonely Hearts Club Band" }, null), true);

  // Still exact, not substring.
  assert.equal(ruleMatches(sgt, { album: "Sgt. Pepper's" }, null), false);
});

test('field:title, tag and mood rules fold with it', () => {
  const title = compileRules([ruleOf('title', ["Livin' La Vida Loca"])])[0]!;
  assert.equal(ruleMatches(title, { title: 'Livin’ La Vida Loca' }, null), true);
  // `name` is the other field a row may carry the title in.
  assert.equal(ruleMatches(title, { name: 'Livin’ La Vida Loca' }, null), true);

  const tag = compileRules([ruleOf('tag', ["rock 'n' roll"])])[0]!;
  assert.equal(ruleMatches(tag, { genres: ['Rock ’n’ Roll'] }, null), true);
  // A hyphen is not an apostrophe: `trip-hop` and `trip hop` stay two tags.
  const hyphen = compileRules([ruleOf('tag', ['trip-hop'])])[0]!;
  assert.equal(ruleMatches(hyphen, { genres: ['trip hop'] }, null), false);
});

test('two rule values differing only in apostrophe style are now one value', () => {
  // blockRuleSchema dedupes on normText, so the pair collapses at save time
  // as well as at compile time.
  const patch = validateRulePatch({ label: 'Blocked', field: 'album', values: ["Sgt. Pepper's", 'Sgt. Pepper’s'] });
  assert.deepEqual(patch.values, ["Sgt. Pepper's"], 'the first spelling typed is the one stored');
  const cr = compileRules([ruleOf('album', ["Sgt. Pepper's", 'Sgt. Pepper’s'])])[0]!;
  assert.equal(cr.valueSet.size, 1);
});

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
