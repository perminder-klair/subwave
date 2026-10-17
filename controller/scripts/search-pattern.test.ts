// util/search-pattern: the RE2 regex and Unicode fold of the Library search,
// plus their SQL twins.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { foldText, regexPattern, registerSearchSql } from '../src/util/search-pattern.js';

test('a regex is case-insensitive, unanchored RE2', () => {
  const p = regexPattern('\\((live|remix)\\)');
  assert.equal(p.test('Song (LIVE)'), true);
  assert.equal(p.test('Liver'), false);
  assert.equal(regexPattern('^åsa').test('Åsa Jinder'), true, 'Unicode case folding');
  assert.equal(regexPattern('^värld$').test('Värld'), true, 'NFC on both sides');
});

test('RE2 refuses what it cannot run in linear time, and an empty pattern', () => {
  assert.throws(() => regexPattern('(live'), /not a valid pattern/);
  assert.throws(() => regexPattern('(a)\\1'), /not a valid pattern/, 'no backreferences');
  assert.throws(() => regexPattern(''), /empty pattern/);
  const started = performance.now();
  assert.equal(regexPattern('(a+)+$').test(`${'a'.repeat(40)}!`), false);
  assert.ok(performance.now() - started < 200, 'catastrophic pattern runs in linear time');
});

test('foldText: NFC, Unicode lower case, one apostrophe', () => {
  assert.equal(foldText('ÅSA'), 'åsa');
  assert.equal(foldText('Värld'), 'värld');
  for (const curly of ['‘', '’', 'ʼ', '´', '`']) {
    assert.equal(foldText(`Don${curly}t`), "don't", `${curly} folds as recency.nameKey folds it`);
  }
});

test('SQL twins: fold() and search_match()', () => {
  const db = new Database(':memory:');
  registerSearchSql(db);
  const one = (sql: string, ...p: unknown[]) => Object.values(db.prepare(sql).get(...p) as object)[0];
  assert.equal(one(`SELECT fold('ÅSA') AS v`), 'åsa', 'unlike LOWER(), fold() is not ASCII-only');
  assert.equal(one(`SELECT search_match(?, 'Song (Live)') AS v`, '\\(live\\)'), 1);
  assert.equal(one(`SELECT search_match(?, 'Song') AS v`, '\\(live\\)'), 0);
  assert.equal(one(`SELECT fold(NULL) AS v`), '', 'a NULL column folds to empty');
  assert.equal(one(`SELECT search_match(?, NULL) AS v`, 'x'), 0);
  db.close();
});
