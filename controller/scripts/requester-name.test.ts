// #1347: the requester's name reached the model but nothing told it to USE the
// name — the only clause was negative — and cleanRequesterName's 'anon'
// stand-in is truthy, so unsigned requests pushed a fake name through too.
// Pins the pair: a named request gets the positive rule and the name, an
// unsigned one gets neither.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANON_REQUESTER, isNamedRequester, cleanRequesterName, sorryNoMatch,
} from '../src/util/request-guard.ts';
import {
  REQUESTER_NAME_CLAUSE, REQUESTER_GREETING_CLAUSE,
} from '../src/llm/internal/prompts/scripts.ts';

test('isNamedRequester rejects the ledger stand-in and blanks', () => {
  assert.equal(isNamedRequester('María'), true);
  assert.equal(isNamedRequester(ANON_REQUESTER), false);
  assert.equal(isNamedRequester(''), false);
  assert.equal(isNamedRequester('   '), false);
  assert.equal(isNamedRequester(null), false);
  assert.equal(isNamedRequester(undefined), false);
});

test("cleanRequesterName's blanking paths all land on a name no prompt will use", () => {
  // All three ways a name is dropped must produce a value isNamedRequester
  // refuses, or a gate added for one path misses another.
  for (const raw of ['', '   ', '🎧🎧', 'DJ', 'admin']) {
    const cleaned = cleanRequesterName(raw, ['dj', 'admin']);
    assert.equal(cleaned, ANON_REQUESTER, `expected ${JSON.stringify(raw)} to blank`);
    assert.equal(isNamedRequester(cleaned), false);
  }
  assert.equal(cleanRequesterName(' María ', ['dj']), 'María');
  assert.equal(isNamedRequester(cleanRequesterName(' María ', ['dj'])), true);
});

test('the greeting clause is positive and the screening clause is still negative', () => {
  // The two clauses answer different questions and both must survive.
  assert.match(REQUESTER_GREETING_CLAUSE, /say it on air/i);
  assert.match(REQUESTER_GREETING_CLAUSE, /\bonce\b/i);
  assert.match(REQUESTER_NAME_CLAUSE, /do not say it on air/i);
  assert.match(REQUESTER_NAME_CLAUSE, /a listener/i);
});

test('the decline copy addresses a signed listener and stays impersonal otherwise', () => {
  assert.equal(sorryNoMatch('María'), 'Sorry María, nothing in the crates matched that.');
  assert.equal(sorryNoMatch(ANON_REQUESTER), 'Sorry, nothing in the crates matched that.');
  assert.equal(sorryNoMatch(''), 'Sorry, nothing in the crates matched that.');
  // The literal 'anon' must not survive into anything aired.
  assert.doesNotMatch(sorryNoMatch(ANON_REQUESTER), /anon/);
});
