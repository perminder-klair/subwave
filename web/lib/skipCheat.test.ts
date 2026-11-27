import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceCheat, CHEAT_GAP_MS, CHEAT_START, keyToken, touchToken, type CheatToken } from './skipCheat';

function run(tokens: CheatToken[], step = 100): boolean[] {
  let state = CHEAT_START;
  return tokens.map((t, i) => {
    const r = advanceCheat(state, t, 1_000 + i * step);
    state = r.state;
    return r.fired;
  });
}

const KONAMI: CheatToken[] = ['up', 'up', 'down', 'down', 'b', 'a'];
const SWIPED: CheatToken[] = ['up', 'up', 'down', 'down', 'tap', 'tap'];

test('the typed sequence fires once, on its last key', () => {
  const fired = run(KONAMI);
  assert.deepEqual(fired.map((f, i) => (f ? i : -1)).filter(i => i >= 0), [5]);
});

test('the swiped sequence fires, two taps standing in for B A', () => {
  assert.equal(run(SWIPED).at(-1), true);
});

test('a tap cannot stand in for an arrow', () => {
  assert.equal(run(['tap', ...KONAMI.slice(1)]).some(Boolean), false);
});

test('an extra opening up still completes', () => {
  assert.equal(run(['up', ...KONAMI]).at(-1), true);
});

test('an up mid-sequence restarts at one, not two', () => {
  assert.equal(run(['up', 'up', 'down', 'down', 'left', 'up', ...KONAMI.slice(1)]).at(-1), true);
  assert.equal(run(['up', 'up', 'down', 'down', 'left', 'up', ...KONAMI.slice(2)]).some(Boolean), false);
});

test('a wrong token resets the sequence', () => {
  assert.equal(run(['up', 'up', 'down', 'left', ...KONAMI.slice(4)]).some(Boolean), false);
});

test('a long pause starts it over', () => {
  assert.equal(run(KONAMI, CHEAT_GAP_MS + 1).some(Boolean), false);
  assert.equal(run(KONAMI, CHEAT_GAP_MS).at(-1), true);
});

test('it fires again after a fresh full sequence', () => {
  const fired = run([...KONAMI, ...KONAMI]);
  assert.equal(fired.filter(Boolean).length, 2);
});

test('keys map to tokens, letters in either case', () => {
  assert.equal(keyToken('ArrowUp'), 'up');
  assert.equal(keyToken('B'), 'b');
  assert.equal(keyToken('a'), 'a');
  assert.equal(keyToken('s'), null);
});

test('touches classify as taps and clean swipes only', () => {
  assert.equal(touchToken(3, -2, 120), 'tap');
  assert.equal(touchToken(0, 0, 900), null); // long press
  assert.equal(touchToken(0, -120, 200), 'up');
  assert.equal(touchToken(0, 90, 200), 'down');
  assert.equal(touchToken(-80, 10, 200), 'left');
  assert.equal(touchToken(80, -5, 200), 'right');
  assert.equal(touchToken(80, 70, 200), null); // diagonal
  assert.equal(touchToken(0, -120, 1_500), null); // slow drag
  assert.equal(touchToken(20, -50, 200), 'up'); // a little off vertical still counts
  assert.equal(touchToken(0, -25, 150), null); // too short for a swipe, too long for a tap
});
