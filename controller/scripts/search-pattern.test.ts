// util/search-pattern: the RE2 regex and Unicode fold of the Library search,
// plus their SQL twins.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { foldText, regexPattern, registerSearchSql, wildcardSource } from '../src/util/search-pattern.js';
import { nameKey } from '../src/music/recency.js';

test('a regex is case-insensitive, unanchored RE2', () => {
  const p = regexPattern('\\((live|remix)\\)');
  assert.equal(p.test('Song (LIVE)'), true);
  assert.equal(p.test('Liver'), false);
  assert.equal(regexPattern('^åsa').test('Åsa Jinder'), true, 'Unicode case folding');
  assert.equal(regexPattern('^värld$').test('Värld'), true, 'NFC on both sides');
  assert.equal(regexPattern("don't").test('Don’t Cry'), true, 'apostrophes fold on both sides, as a name key folds them');
  assert.equal(regexPattern('don’t').test("Don't Cry"), true);
});

test('RE2 refuses what it cannot run in linear time, and an empty pattern', () => {
  assert.throws(() => regexPattern('(live'), /not a valid pattern/);
  assert.throws(() => regexPattern('(a)\\1'), /not a valid pattern/, 'no backreferences');
  assert.throws(() => regexPattern(''), /empty pattern/);
  const started = performance.now();
  assert.equal(regexPattern('(a+)+$').test(`${'a'.repeat(40)}!`), false);
  assert.ok(performance.now() - started < 200, 'catastrophic pattern runs in linear time');
});

test('foldText: NFC, Unicode lower case, one apostrophe, one space', () => {
  assert.equal(foldText('ÅSA'), 'åsa');
  assert.equal(foldText('Värld'), 'värld');
  for (const curly of ['‘', '’', 'ʼ', '´', '`']) {
    assert.equal(foldText(`Don${curly}t`), "don't", `${curly} folds as recency.nameKey folds it`);
  }
  assert.equal(foldText('Hip \t Hop'), 'hip hop', 'a run of whitespace is one space, as in a name key');
  assert.equal(foldText(' edge '), ' edge ', 'but not trimmed: a search may mean the space at its edge');
});

test('foldText is recency.nameKey less its trim, so a search and a stored key agree', () => {
  for (const s of ['ÅSA', 'A\u030Asa', 'Don’t', 'Guns N` Roses', 'Hip \t\n Hop', '  Edge  ', 'ʼ´‘’', '', 'İstanbul', 'ΣΊΣΥΦΟΣ']) {
    assert.equal(foldText(s).trim(), nameKey(s), JSON.stringify(s));
  }
});

test('wildcardSource: `*` is one or more characters, `?` one, the rest literal', () => {
  assert.equal(wildcardSource('Chr*s'), 'chr.+s');
  assert.equal(wildcardSource('a**b?c'), 'a.+b.c');
  assert.equal(wildcardSource('1.5 (x)*'), '1\\.5 \\(x\\).+');
  assert.equal(regexPattern(wildcardSource('hip?hop')).test('hip hop'), true);
  assert.equal(regexPattern(wildcardSource('dri*ll')).test('drill'), false, 'one or more, not zero');
});

test('SQL twins: search_match(), search_match_entry() and collapse_space()', () => {
  const db = new Database(':memory:');
  registerSearchSql(db);
  const one = (sql: string, ...p: unknown[]) => Object.values(db.prepare(sql).get(...p) as object)[0];
  assert.equal(one(`SELECT search_match(?, 'Song (Live)') AS v`, '\\(live\\)'), 1);
  assert.equal(one(`SELECT search_match(?, 'Song') AS v`, '\\(live\\)'), 0);
  assert.equal(one(`SELECT collapse_space('Hip  Hop') AS v`), 'Hip Hop', 'spacing only, case kept');
  assert.equal(one(`SELECT collapse_space(NULL) AS v`), '');
  assert.equal(one(`SELECT search_match(?, NULL) AS v`, 'x'), 0);
  const list = '\u001fhip hop\u001frock\u001f';
  const entry = (source: string, l: unknown = list) => one(`SELECT search_match_entry(?, ?, char(31)) AS v`, source, l);
  assert.equal(entry('^rock$'), 1, 'each entry on its own, anchors and all');
  assert.equal(entry('^hip'), 1);
  assert.equal(entry('hop.rock'), 0, 'never across two entries');
  assert.equal(entry('^$'), 0, 'the empty ends of the list are not entries');
  assert.equal(entry('x', null), 0, 'a NULL list has none');
  db.close();
});

test('search_match stays right however many sources a query interleaves', () => {
  const db = new Database(':memory:');
  registerSearchSql(db);
  // More sources than the cache holds: a full cache starts over, still right.
  const sources = Array.from({ length: 300 }, (_, i) => `^s${i}$`);
  const hits = db.prepare(`SELECT search_match(?, ?) + search_match(?, ?) AS v`);
  for (const [i, src] of sources.entries()) {
    assert.equal((hits.get(src, `s${i}`, sources[0], 's0') as { v: number }).v, 2, src);
  }
  db.close();
});
