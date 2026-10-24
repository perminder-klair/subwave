import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-request-ledger-'));
process.env.STATE_DIR = stateDir;

const ledger = await import('../src/broadcast/request-ledger.js');

test('request ledger persists receipts, latest Alexa identity and terminal updates', async () => {
  const identity = ledger.alexaIdentityKey('alexa-account-test');
  await ledger.createPending({
    id: 'ledger-test-1',
    createdAt: Date.now(),
    source: 'alexa',
    requester: '',
    text: 'Daft Punk',
    alexaIdentity: identity,
  });

  assert.equal(ledger.get('ledger-test-1')?.status, 'pending');
  assert.equal(ledger.latestForAlexa(identity)?.id, 'ledger-test-1');

  await ledger.update('ledger-test-1', {
    status: 'resolved',
    ack: 'Queued.',
    track: { title: 'Around the World', artist: 'Daft Punk' },
    queuePosition: 1,
  });

  const stored = JSON.parse(readFileSync(ledger.ledgerPath, 'utf8'));
  assert.equal(stored.records[0].status, 'resolved');
  assert.equal(stored.records[0].track.title, 'Around the World');
  assert.equal(statSync(ledger.ledgerPath).mode & 0o777, 0o600);
});
test('startup reconciliation interrupts uncertain pending work without replaying it', async () => {
  await ledger.createPending({
    id: 'ledger-test-2',
    createdAt: Date.now(),
    source: 'web',
    requester: 'listener',
    text: 'Miles Davis',
  });

  await ledger.interruptUnresolved(new Set());
  const record = ledger.get('ledger-test-2');
  assert.equal(record?.status, 'interrupted');
  assert.match(record?.message || '', /restarted/i);

  // The reconciliation pass is idempotent and does not alter a known queue id.
  await ledger.createPending({
    id: 'ledger-test-3',
    createdAt: Date.now(),
    source: 'web',
    requester: 'listener',
    text: 'Nina Simone',
  });
  await ledger.interruptUnresolved(new Set(['ledger-test-3']));
  assert.equal(ledger.get('ledger-test-3')?.status, 'pending');
});

test('a late update cannot move latest Alexa status back to an older request', async () => {
  const identity = ledger.alexaIdentityKey('alexa-account-ordering');
  const now = Date.now();
  await ledger.createPending({
    id: 'ledger-test-old',
    createdAt: now,
    source: 'alexa',
    requester: '',
    text: 'Older request',
    alexaIdentity: identity,
  });
  await ledger.createPending({
    id: 'ledger-test-new',
    createdAt: now + 1,
    source: 'alexa',
    requester: '',
    text: 'Newer request',
    alexaIdentity: identity,
  });

  await ledger.update('ledger-test-old', { status: 'resolved', outcome: 'matched' });
  assert.equal(ledger.latestForAlexa(identity)?.id, 'ledger-test-new');
});
