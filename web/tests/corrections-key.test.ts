import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correctionsKey } from '../components/admin/tts/correctionsKey';

// `correctionsKey` is a React dependency value, so its whole job is to be equal for
// equal CONTENT and DISTINCT for content the render server can tell apart. The
// second half is the one that is easy to get wrong and impossible to see: a key
// that collides does not throw, does not warn, and simply leaves the previous
// render's audio playing under a label that no longer matches it.
//
// These cases exist because the first implementation was
// `map(c => `${c.from} ${c.to}`).join('|')`, and review found two collisions in it.
// The AST test in voice-preview-invalidation.test.ts can only confirm the memo is
// wired to the right prop — it cannot see a collision inside the key function, so
// that property is pinned here where it can be.

test('a separator inside a value cannot forge a pair boundary', () => {
  // The reviewer's case, verbatim. Both payloads are legal corrections.
  const one = [{ from: 'a', to: 'b|c d' }];
  const two = [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }];

  assert.notEqual(correctionsKey(one), correctionsKey(two),
    'these two payloads reach the render server differently, so their keys must differ');
});

test('"use the saved corrections" and "use none" are different requests', () => {
  // `undefined` means the server applies the station's saved overrides; `[]` means
  // none. A key that merges them lets a preview claim to reflect "no corrections"
  // while playing the saved ones — the same stale-audio failure, one level up.
  assert.notEqual(correctionsKey(undefined), correctionsKey([]),
    'undefined (use saved) and [] (use none) are different render requests');
});

test('equal content always produces an equal key', () => {
  // The other half of the contract. A key that is too eager to differ would
  // re-run the invalidation effect on every render and discard a fresh sample the
  // instant it finished rendering — so this must hold for structurally equal input
  // built separately.
  const a = [{ from: 'Sook', to: 'look' }, { from: 'Ng', to: 'in' }];
  const b = [{ from: 'Sook', to: 'look' }, { from: 'Ng', to: 'in' }];
  assert.equal(correctionsKey(a), correctionsKey(b));
  assert.equal(correctionsKey(undefined), correctionsKey(undefined));
  assert.equal(correctionsKey([]), correctionsKey([]));
});

test('order is significant, because the server applies the list in order', () => {
  // Two overlapping corrections are not interchangeable — `a->b, b->c` and
  // `b->c, a->b` can resolve differently depending on which runs first.
  assert.notEqual(
    correctionsKey([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]),
    correctionsKey([{ from: 'b', to: 'c' }, { from: 'a', to: 'b' }]),
  );
});

test('a changed correction always changes the key', () => {
  const before = correctionsKey([{ from: 'Sook', to: 'look' }]);
  const after = correctionsKey([{ from: 'Sook', to: 'book' }]);
  assert.notEqual(before, after,
    'a changed `to` is a changed render, and must not reuse the previous audio');
});