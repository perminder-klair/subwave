// Regression test for issue #1611: the blocklist's two name tiers must fold a
// name the same way.
//
// Since #1603 the ARTIST tier keyed with `recency.artistNameKey` (case, curly-
// vs-straight apostrophes, whitespace) while the ALBUM tier still keyed with a
// module-local `norm` that folded case and whitespace only. So an album entry
// stored from a row tagged "Guns N’ Roses" missed the same album tagged
// "Guns N' Roses", and vice versa, while an artist entry did not — two tiers of
// ONE absolute list disagreeing about what one string means.
//
// The fix WIDENS an absolute list: folding two spellings of one name onto one
// key blocks rows the previous spelling missed. That is the whole behaviour
// change, and it is safe for the same reason the artist fold was — an
// apostrophe style is which ripper wrote the file, never which record it is.
// Nothing here may widen further: this list has NO never-starve anywhere,
// listener requests included, so a key that folds two DIFFERENT names together
// silently removes music the operator never blocked.
//
// Four things are pinned:
//   1. Both halves of the album key fold. An album title carries an apostrophe
//      as often as a band name, and folding one side only moves the
//      disagreement rather than fixing it.
//   2. The artist half of the album key answers exactly as the artist tier
//      does — one normaliser, asserted against `artistNameKey` itself.
//   3. `schemas/blocklist.ts` normText, which the `album`/`title`/`tag`/`mood`
//      RULES compile and match with, folds identically — it is mirrored into
//      the web bundle so it must RESTATE the fold rather than import it, and a
//      restatement is exactly what drifts. Rules and id entries answer the same
//      question about the same row.
//   4. What did NOT widen: the (album, artist) pair is still a pair, other
//      punctuation is still not folded, and two different names still key apart.
//
// Run: `tsx scripts/blocklist-name-fold.test.ts`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time, so EVERY
// src import here is dynamic and lives below the assignment — this test writes
// a blocklist.json, and a static import that pulls config.js in ahead of the
// line would write it into the operator's real state dir.
const stateDir = mkdtempSync(join(tmpdir(), 'blocklist-fold-test-'));
process.env.STATE_DIR = stateDir;

const { artistNameKey, nameKey } = await import('../src/music/recency.js');
const { compileRules, ruleMatches, normText, validateRulePatch } = await import('../src/music/blocklist-rules.js');
type BlockRule = import('../src/music/blocklist-rules.js').BlockRule;
const blocklist = await import('../src/music/blocklist.js');

// The apostrophe shapes `recency.APOSTROPHES` folds, each paired with the
// straight-quote spelling it has to become. A catalogue tagged from more than
// one source carries all of them.
const CURLY = ['Guns N’ Roses', 'Guns N‘ Roses', 'Guns Nʼ Roses', 'Guns N´ Roses', 'Guns N` Roses'];
const STRAIGHT = "Guns N' Roses";

// ── The two folds, side by side ─────────────────────────────────────────────

test('nameKey and artistNameKey are one function', () => {
  // artistNameKey is the artist-facing NAME for the fold, kept because every
  // #1603 call site and comment says it. If they ever become two functions,
  // the album tier and the artist tier can disagree again.
  assert.equal(nameKey, artistNameKey);
});

test('schemas/blocklist normText restates nameKey exactly', () => {
  // normText cannot import nameKey — a mirrored schema module may import only
  // zod — so it restates the fold, and a restatement is what drifts. This is
  // the pin: the rule half and the id half must answer identically.
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
  // Same answer for the non-string shapes both readers meet: a library row's
  // null album, an absent field.
  for (const raw of [null, undefined]) {
    assert.equal(normText(raw), nameKey(raw), String(raw));
  }
});

test('the fold folds apostrophe style and nothing else about the name', () => {
  for (const curly of CURLY) {
    assert.equal(nameKey(curly), "guns n' roses", curly);
  }
  // Other punctuation is NOT folded — a hyphen distinguishes real vocabulary
  // (`trip-hop` is its own tag) and this list has no never-starve behind it.
  assert.notEqual(nameKey('trip-hop'), nameKey('trip hop'));
  assert.notEqual(nameKey('AC/DC'), nameKey('AC DC'));
  // And a fold never empties or renames: "Sunn O)))" is a band, not brackets.
  assert.equal(nameKey('Sunn O)))'), 'sunn o)))');
});

// ── The album id tier ───────────────────────────────────────────────────────

test('an album entry blocks the apostrophe variant of the same row', async () => {
  await blocklist.load();
  // Stored the way POST /library/blocklist persists it: display snapshots off
  // the track row that was blocked, curly apostrophe and all.
  await blocklist.add({
    type: 'album',
    id: 'alb-cd',
    name: 'Chinese Democracy',
    artist: 'Guns N’ Roses',
  });

  // The acceptance case, both directions.
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
  // Case and whitespace still fold too — the pre-#1611 behaviour is a subset.
  assert.equal(
    blocklist.isBlocked({ id: 's3', album: '  chinese   democracy ', artist: STRAIGHT }),
    true,
  );

  // The admin badge has to name the entry that caused it, so the operator can
  // unblock exactly that one — matchOf's ordering contract.
  assert.deepEqual(
    blocklist.hitOf({ id: 's4', album: 'Chinese Democracy', artist: STRAIGHT }),
    { kind: 'entry', type: 'album', id: 'alb-cd', name: 'Chinese Democracy' },
  );

  await blocklist.remove('album', 'alb-cd');
});

test('the ALBUM half of the key folds too, not just the artist half', async () => {
  // Stored with a straight apostrophe in the TITLE this time — the reverse
  // direction, and the half a fix that only touched the artist name would miss.
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
  // Both halves at once, each in the other style.
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
  // One normaliser, asserted rather than described: for every spelling the
  // artist tier folds together, the album tier folds them together too.
  //
  // The two entries are probed with only ONE of them in the list at a time.
  // matchOf answers artist-tier BEFORE album-tier by contract, so an artist
  // entry left in place claims every row here and the album half is never
  // reached — the shape in which this whole test passes against the unfixed
  // module.
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
  // This list is absolute, with no never-starve anywhere and requests included,
  // so what did NOT widen is as load-bearing as what did. The artist half of
  // the key exists so a generic title cannot cross-match another artist's
  // album, and folding the fold must not have collapsed it.
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
  // And the separator still does its job: ("a b", "c") must not equal
  // ("a", "b c"), which is what the NUL between the halves is for.
  await blocklist.add({ type: 'album', id: 'alb-sep', name: 'a b', artist: 'c' });
  assert.equal(blocklist.isBlocked({ id: 'n6', album: 'a', artist: 'b c' }), false);

  await blocklist.remove('album', 'alb-gh');
  await blocklist.remove('album', 'alb-sep');
});

// ── The rule half, which must answer the same way ───────────────────────────

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
  // A hyphen is still not an apostrophe: `trip-hop` and `trip hop` stay two
  // tags, which is what scene-references' orphan scan depends on.
  const hyphen = compileRules([ruleOf('tag', ['trip-hop'])])[0]!;
  assert.equal(ruleMatches(hyphen, { genres: ['trip hop'] }, null), false);
});

test('two rule values differing only in apostrophe style are now one value', () => {
  // The dedupe in blockRuleSchema keys on normText, so the pair collapses at
  // SAVE time as well as at compile time. Before #1611 both spellings were
  // stored and then compiled to one key anyway, which showed the operator two
  // rows that block identically — the same drift one field over.
  const patch = validateRulePatch({ label: 'Blocked', field: 'album', values: ["Sgt. Pepper's", 'Sgt. Pepper’s'] });
  assert.deepEqual(patch.values, ["Sgt. Pepper's"], 'the first spelling typed is the one stored');
  const cr = compileRules([ruleOf('album', ["Sgt. Pepper's", 'Sgt. Pepper’s'])])[0]!;
  assert.equal(cr.valueSet.size, 1);
});

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
