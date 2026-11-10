// The Cipher machine's state lives in a store outside React so the ambient
// clock re-renders only the parts that show it. Pinned here: the store wakes
// its readers only when something changed (the point of it), the rotors the
// clock turns are the ones a typed letter steps from, and the lampboard hands
// itself to the keys the moment a message is on the tape.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepRotors } from './cipher';
import { STILL, createMachineStore, litOf, type Frame } from './machineStore';

const clock = (f: Partial<Frame> = {}): Frame => ({ ...STILL, keys: false, ...f });

function counted(store: ReturnType<typeof createMachineStore>) {
  let wakes = 0;
  const stop = store.subscribe(() => { wakes++; });
  return { wakes: () => wakes, stop };
}

test('the store wakes its readers only when the state changes', () => {
  const store = createMachineStore({ middle: 10, right: 16 });
  const reader = counted(store);

  store.dispatch({ type: 'frame', frame: clock({ lit: 'Q', cursor: 0 }) });
  assert.equal(reader.wakes(), 1);
  // The same frame again, a release with no key down, an unlight with no
  // bulb lit, a delete on an empty tape: nothing to show, nobody woken.
  store.dispatch({ type: 'frame', frame: clock({ lit: 'Q', cursor: 0 }) });
  store.dispatch({ type: 'up' });
  store.dispatch({ type: 'unlight' });
  store.dispatch({ type: 'del' });
  store.dispatch({ type: 'rotors', rotors: { middle: 10, right: 16 } });
  assert.equal(reader.wakes(), 1);

  reader.stop();
  store.dispatch({ type: 'frame', frame: clock({ lit: 'W', cursor: 1 }) });
  assert.equal(reader.wakes(), 1);
});

test('a typed letter steps the rotors from where the clock left them', () => {
  const store = createMachineStore({ middle: 10, right: 16 });
  store.dispatch({ type: 'frame', frame: clock({ lit: 'Q' }), rotors: { middle: 3, right: 20 } });
  store.dispatch({ type: 'frame', frame: clock({ lit: 'W' }), rotors: 'step' });
  assert.deepEqual(store.get().msg.rotors, stepRotors({ middle: 3, right: 20 }));

  store.dispatch({ type: 'type', ch: 'a', vol: 18 });
  const { msg } = store.get();
  assert.equal(msg.plain, 'A');
  assert.deepEqual(msg.rotors, stepRotors(stepRotors({ middle: 3, right: 20 })));
  // Delete puts back the rotors the clock left.
  store.dispatch({ type: 'del' });
  assert.deepEqual(store.get().msg.rotors, stepRotors({ middle: 3, right: 20 }));
});

test('the lampboard shows the clock until a message is on the tape', () => {
  const store = createMachineStore({ middle: 0, right: 0 });
  store.dispatch({ type: 'frame', frame: clock({ lit: 'Q' }) });
  assert.equal(litOf(store.get()), 'Q');

  // The first letter takes the board even before the clock stands down.
  store.dispatch({ type: 'type', ch: 'a', vol: 0 });
  const { keyLit } = store.get();
  assert.ok(keyLit);
  assert.equal(litOf(store.get()), keyLit);

  // With the tape empty again and the clock off, the keys still have it.
  store.dispatch({ type: 'clear' });
  store.dispatch({ type: 'frame', frame: STILL });
  assert.equal(litOf(store.get()), null);
});

test('a held key goes down once and comes up once', () => {
  const store = createMachineStore({ middle: 0, right: 0 });
  const reader = counted(store);
  store.dispatch({ type: 'type', ch: ' ', vol: 0 });
  assert.equal(store.get().down, 'SPACE');
  // A leading space types nothing; holding it again changes nothing.
  store.dispatch({ type: 'type', ch: ' ', vol: 0 });
  assert.equal(reader.wakes(), 1);
  store.dispatch({ type: 'up' });
  assert.equal(store.get().down, null);
  assert.equal(reader.wakes(), 2);
});
