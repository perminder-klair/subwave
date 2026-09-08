// The blocklist's rule entries (music/blocklist-rules.ts): season windows,
// show scoping, per-field matching and payload validation. Tracks carry their
// tag arrays inline so the show-filter readers never reach for library-db.

import assert from 'node:assert/strict';
import {
  compileRules,
  coerceStoredRule,
  inSeason,
  ruleActive,
  ruleMatches,
  validateRulePatch,
  type BlockRule,
} from '../src/music/blocklist-rules.js';

const rule = (over: Partial<BlockRule> = {}): BlockRule => ({
  id: 'r1',
  label: 'Test rule',
  field: 'tag',
  values: ['christmas'],
  season: null,
  showIds: [],
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const compiled = (over: Partial<BlockRule> = {}) => compileRules([rule(over)])[0]!;

// Season windows.

const DEC_TO_JAN = { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } };
const SUMMER = { from: { month: 6, day: 15 }, to: { month: 8, day: 31 } };

// Plain interval, inclusive on both bounds.
assert.equal(inSeason(SUMMER, { month: 6, day: 15 }), true, 'from bound is inclusive');
assert.equal(inSeason(SUMMER, { month: 8, day: 31 }), true, 'to bound is inclusive');
assert.equal(inSeason(SUMMER, { month: 6, day: 14 }), false);
assert.equal(inSeason(SUMMER, { month: 9, day: 1 }), false);
assert.equal(inSeason(SUMMER, { month: 12, day: 25 }), false);

// Year-end wrap: Dec 1 → Jan 6 is active on Jan 3 and Dec 25, not in July.
assert.equal(inSeason(DEC_TO_JAN, { month: 1, day: 3 }), true, 'wrap: early January is in season');
assert.equal(inSeason(DEC_TO_JAN, { month: 12, day: 25 }), true, 'wrap: December is in season');
assert.equal(inSeason(DEC_TO_JAN, { month: 12, day: 1 }), true, 'wrap: from bound inclusive');
assert.equal(inSeason(DEC_TO_JAN, { month: 1, day: 6 }), true, 'wrap: to bound inclusive');
assert.equal(inSeason(DEC_TO_JAN, { month: 7, day: 15 }), false, 'wrap: July is out of season');
assert.equal(inSeason(DEC_TO_JAN, { month: 1, day: 7 }), false, 'wrap: just past the to bound');
assert.equal(inSeason(DEC_TO_JAN, { month: 11, day: 30 }), false, 'wrap: just before the from bound');

// Rule activity (season + scope).

const july = { month: 7, day: 15, activeShowId: null };
const xmas = { month: 12, day: 25, activeShowId: null };

// No season, no scope: always blocking.
assert.equal(ruleActive(rule(), july), true);

// Seasonal rule: blocks OUT of season, inert IN season.
assert.equal(ruleActive(rule({ season: DEC_TO_JAN }), july), true, 'out of season → blocking');
assert.equal(ruleActive(rule({ season: DEC_TO_JAN }), xmas), false, 'in season → inert');

// Show scope: active only while a listed show is on air, so a scoped rule can
// never over-block outside its show.
const scoped = rule({ showIds: ['morning-show'] });
assert.equal(ruleActive(scoped, { ...july, activeShowId: 'morning-show' }), true);
assert.equal(ruleActive(scoped, { ...july, activeShowId: 'late-show' }), false);
assert.equal(ruleActive(scoped, july), false, 'no show on air → scoped rule inert');

// Season + scope compose: blocking only during the show AND out of season.
const both = rule({ season: DEC_TO_JAN, showIds: ['morning-show'] });
assert.equal(ruleActive(both, { ...july, activeShowId: 'morning-show' }), true);
assert.equal(ruleActive(both, { ...xmas, activeShowId: 'morning-show' }), false, 'in season wins even in scope');
assert.equal(ruleActive(both, july), false);

// Field matching: genre.

// Same direction as the show filters: blocking a broad genre drops its
// refinements, blocking a narrow one never drops the broad tag.
const punkRule = compiled({ field: 'genre', values: ['Punk'] });
assert.equal(ruleMatches(punkRule, { genres: ['Punk Rock'] }, null), true, 'blocking Punk drops Punk Rock');
assert.equal(ruleMatches(punkRule, { genres: ['punk'] }, null), true, 'exact, case-insensitive');
assert.equal(ruleMatches(compiled({ field: 'genre', values: ['Pop Punk'] }), { genres: ['Pop'] }, null), false, 'blocking Pop Punk keeps plain Pop');
assert.equal(ruleMatches(compiled({ field: 'genre', values: ['Rap'] }), { genres: ['Trap'] }, null), false, 'word boundary: Rap does not drop Trap');
assert.equal(ruleMatches(punkRule, { genres: ['Jazz'], genre: null }, null), false);
assert.equal(ruleMatches(punkRule, { genre: 'Punk' }, null), true, 'legacy scalar genre field still matches');

// Field matching: tag (any-namespace exact union).

const xmasTag = compiled({ field: 'tag', values: ['Christmas'] });
assert.equal(ruleMatches(xmasTag, { genres: ['Christmas'] }, null), true, 'tag matches a genre tag');
assert.equal(ruleMatches(xmasTag, { genres: ['Rock'], moods: ['christmas'] }, null), true, 'tag matches an editorial mood');
assert.equal(ruleMatches(xmasTag, { genres: ['Rock'], moods: [], audioMoods: ['Christmas'] }, null), true, 'tag matches an audio mood');
assert.equal(ruleMatches(xmasTag, { genres: ['Rock'], moods: [], lastfmTags: ['christmas'] }, null), true, 'tag matches a Last.fm tag');
assert.equal(ruleMatches(xmasTag, { genres: ['Christmas Rock'], moods: [] }, null), false, 'tag is EXACT, not substring/refine');
assert.equal(ruleMatches(xmasTag, { genres: ['Rock'], moods: ['cosy'] }, null), false);

// Field matching: mood.

const gloomy = compiled({ field: 'mood', values: ['Gloomy'] });
assert.equal(ruleMatches(gloomy, { moods: ['gloomy'], audioMoods: [] }, null), true);
assert.equal(ruleMatches(gloomy, { moods: [], audioMoods: ['Gloomy'] }, null), true, 'audio moods count (retrieval-blend parity)');
assert.equal(ruleMatches(gloomy, { moods: ['upbeat'], audioMoods: [] }, null), false);

// Field matching: artist / album / title (normalised exact).

const artistRule = compiled({ field: 'artist', values: ['Ambient Guy'] });
assert.equal(ruleMatches(artistRule, { artist: ' ambient  guy ' }, null), true, 'normalised: trim/case/whitespace');
assert.equal(ruleMatches(artistRule, { artist: 'Ambient Guy Trio' }, null), false, 'exact only, no substring');
assert.equal(ruleMatches(compiled({ field: 'album', values: ['Xmas Hits'] }), { album: 'xmas hits' }, null), true);
assert.equal(ruleMatches(compiled({ field: 'title', values: ['Last Christmas'] }), { title: 'last christmas' }, null), true);
assert.equal(ruleMatches(compiled({ field: 'title', values: ['Last Christmas'] }), { name: 'Last Christmas' }, null), true, 'title falls back to `name` (Subsonic children)');

// Field matching: playlist membership.

const plRule = compiled({ field: 'playlist', values: ['pl-1', 'pl-gone'] });
const members = new Map([['pl-1', new Set(['t1', 't2'])]]);
assert.equal(ruleMatches(plRule, { id: 't1' }, members), true);
assert.equal(ruleMatches(plRule, { id: 't9' }, members), false);
assert.equal(ruleMatches(plRule, { id: 't1' }, null), false, 'no member sets resolved → inert, never wrong');
assert.equal(ruleMatches(plRule, { id: 't1' }, new Map()), false, 'stale/deleted playlist id is inert');

// Null / empty tracks never match anything.
assert.equal(ruleMatches(xmasTag, null, null), false);
assert.equal(ruleMatches(artistRule, {}, null), false);

// Payload validation.

const ok = validateRulePatch({ label: 'Xmas', field: 'tag', values: ['christmas'], season: DEC_TO_JAN, showIds: ['s1'] });
assert.deepEqual(ok, { label: 'Xmas', field: 'tag', values: ['christmas'], season: DEC_TO_JAN, showIds: ['s1'] });

// Values: trimmed, deduped (case/whitespace-insensitively), empties dropped.
assert.deepEqual(
  validateRulePatch({ label: 'x', field: 'tag', values: [' A ', 'a', '', 'B'] }).values,
  ['A', 'B'],
);

assert.throws(() => validateRulePatch({ field: 'tag', values: ['x'] }), /label/, 'label required');
assert.throws(() => validateRulePatch({ label: 'x', field: 'bogus', values: ['x'] }), /field/, 'field enum');
assert.throws(() => validateRulePatch({ label: 'x', field: 'tag', values: [] }), /values/, 'at least one value');
assert.throws(() => validateRulePatch({ label: 'x', field: 'tag', values: ['  '] }), /values/, 'whitespace-only value is no value');
assert.throws(() => validateRulePatch({ label: 'x', field: 'tag', values: Array.from({ length: 13 }, (_, i) => `v${i}`) }), /at most/, 'values cap');
assert.throws(() => validateRulePatch({ label: 'x', field: 'tag', values: ['x'], season: { from: { month: 13, day: 1 }, to: { month: 1, day: 1 } } }), /month/, 'month bounds');
assert.throws(() => validateRulePatch({ label: 'x', field: 'tag', values: ['x'], season: { from: { month: 12, day: 1 } } }), /season\.to/, 'season needs both bounds');
assert.throws(() => validateRulePatch({ label: 'x', field: 'tag', values: ['x'], showIds: 'nope' }), /showIds/, 'showIds must be an array');

// season: null / absent both mean "always blocks".
assert.equal(validateRulePatch({ label: 'x', field: 'tag', values: ['x'] }).season, null);
assert.equal(validateRulePatch({ label: 'x', field: 'tag', values: ['x'], season: null }).season, null);

// Stored-record coercion (blocklist.json load path).

assert.deepEqual(coerceStoredRule(rule()), rule(), 'a valid stored rule round-trips untouched');
assert.equal(coerceStoredRule({ ...rule(), id: '' }), null, 'no id → dropped');
assert.equal(coerceStoredRule({ ...rule(), field: 'bogus' }), null, 'unknown field → dropped, not boot-blocking');
assert.equal(coerceStoredRule('junk'), null);
assert.ok(coerceStoredRule({ id: 'r2', label: 'x', field: 'tag', values: ['a'] })!.addedAt, 'missing addedAt is backfilled');

console.log('blocklist-rules.test.ts: all assertions passed');
