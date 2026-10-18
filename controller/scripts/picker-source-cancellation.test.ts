import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedPickerSource, clearPickerSourceCache, pickerSourceAvailable } from '../src/llm/internal/tools/picker/source-pool-cache.js';

test('different caller deadlines cannot cancel a joined source read', async () => {
  clearPickerSourceCache();
  const pick = new AbortController();
  const request = new AbortController();
  let finishRequest!: (rows: any[]) => void;
  let calls = 0;
  const pickRead = cachedPickerSource('shared', () => {
    calls++;
    return new Promise((_resolve, reject) => pick.signal.addEventListener('abort', () => reject(pick.signal.reason), { once: true }));
  }, undefined, pick.signal);
  const rejected = assert.rejects(pickRead, /pick deadline/);
  const requestRead = cachedPickerSource('shared', () => {
    calls++;
    return new Promise(resolve => { finishRequest = resolve; });
  }, undefined, request.signal);
  pick.abort(new Error('pick deadline'));
  await rejected;
  assert.equal(request.signal.aborted, false);
  finishRequest([{ id: 'available' }]);
  assert.deepEqual(await requestRead, [{ id: 'available' }]);
  assert.equal(calls, 2, 'independent cancellation lifetimes get independent unfinished reads');
  assert.deepEqual(await cachedPickerSource('shared', async () => { throw new Error('completed cache missed'); }), [{ id: 'available' }]);
});

test('callers sharing a signal still coalesce and recollect from a completed pool', async () => {
  clearPickerSourceCache();
  const controller = new AbortController();
  let finish!: (rows: any[]) => void;
  let calls = 0;
  const read = () => { calls++; return new Promise<any[]>(resolve => { finish = resolve; }); };
  const first = cachedPickerSource('same', read, undefined, controller.signal);
  const second = cachedPickerSource('same', read, undefined, controller.signal);
  assert.equal(calls, 1);
  finish([{ id: 'same' }]);
  assert.deepEqual(await first, await second);
});

test('a cancelled source cannot publish an empty cooldown even if its I/O ignores cancellation', async () => {
  clearPickerSourceCache();
  const controller = new AbortController();
  let finish!: (rows: any[]) => void;
  const pending = cachedPickerSource('late-empty', () => new Promise(resolve => { finish = resolve; }), 'availability', controller.signal);
  controller.abort(new Error('cancelled'));
  finish([]);
  await assert.rejects(pending, /cancelled/);
  assert.equal(pickerSourceAvailable('availability'), true);
  assert.deepEqual(await cachedPickerSource('late-empty', async () => [{ id: 'fresh' }]), [{ id: 'fresh' }]);
  await assert.rejects(cachedPickerSource('late-empty', async () => [], undefined, controller.signal), /cancelled/);
});
