// Both corrective re-picks (the next-track pick's and the listener request's)
// type the id as a plain string (#939), so resolveRepickId is where an answer is
// held to the re-pick's own candidates. State lives in a temp dir.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-repick-id-'));
process.env.STATE_DIR = stateRoot;

const { resolveRepickId } = await import('../src/broadcast/dj-agent.js');

after(() => rmSync(stateRoot, { recursive: true, force: true }));

const seen = new Map<string, unknown>([
  ['aB3dE5gH7jK9mN1pQ3sT5v', { title: 'Teardrop' }],
  ['zY8xW6vU4tS2rQ0pO8nM6l', { title: 'Glory Box' }],
]);

test('an exact candidate id passes through unchanged', () => {
  const outcome = { id: 'zY8xW6vU4tS2rQ0pO8nM6l', ack: 'Coming right up' };
  assert.equal(resolveRepickId(outcome, seen, 'request-repick'), outcome);
});

test('a small model\'s id slip is repaired to the candidate it meant, keeping the rest of the answer', () => {
  assert.deepEqual(
    resolveRepickId({ id: 'aB3dE5gH7jK9mN1pQ3sT5w', ack: 'Coming right up', intro: 'Here it is' }, seen, 'request-repick'),
    { id: 'aB3dE5gH7jK9mN1pQ3sT5v', ack: 'Coming right up', intro: 'Here it is' },
  );
  assert.equal(resolveRepickId({ id: 'aB3dE5gH7jK9mN1pQ3sT5', reason: 'x' }, seen, 'repick')?.id,
    'aB3dE5gH7jK9mN1pQ3sT5v', 'a dropped final character is a prefix match');
});

test('anything that is not one of the candidates is no salvage at all', () => {
  assert.equal(resolveRepickId({ id: 'outside-the-offered-catalogue' }, seen, 'request-repick'), null);
  assert.equal(resolveRepickId({ id: null }, seen, 'repick'), null);
  assert.equal(resolveRepickId({}, seen, 'repick'), null);
  assert.equal(resolveRepickId(null, seen, 'repick'), null);
  assert.equal(resolveRepickId({ id: 'aB3dE5gH7jK9mN1pQ3sT5w' }, new Map(), 'repick'), null);
});
