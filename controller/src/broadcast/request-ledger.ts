// Durable listener-request receipts. The live request map in routes/request.ts
// is intentionally fast and short-lived; this ledger keeps the receipt and the
// latest Alexa request available across a controller restart without replaying
// uncertain work.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STATE_DIR } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

export type LedgerStatus = 'pending' | 'resolved' | 'failed' | 'interrupted' | 'cancelled';

export interface RequestDedication {
  target: string;
  locale: 'en-US' | 'en-IN' | 'hi-IN';
}

export interface RequestReminder {
  alertToken: string;
  createdAt: number;
  triggerAt: number;
  forecastSeconds: number;
  leadSeconds: number;
}

export interface RequestReminderConsent {
  permissionToken: string;
  locale: 'en-US' | 'en-IN' | 'hi-IN';
  createdAt: number;
  expiresAt: number;
}

export interface RequestLedgerRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: LedgerStatus;
  source: 'web' | 'alexa';
  requester: string;
  text: string;
  track?: { id?: string; title?: string | null; artist?: string | null } | null;
  ack?: string | null;
  outcome?: string | null;
  message?: string | null;
  queuePosition?: number | null;
  alexaIdentity?: string;
  dedication?: RequestDedication | null;
  reminder?: RequestReminder | null;
  reminderConsent?: RequestReminderConsent | null;
}

interface StoredLedger {
  version: 2;
  salt: string;
  records: RequestLedgerRecord[];
  latestAlexa: Record<string, string>;
  replacementRecovery: { previousId: string; replacementId: string; identity: string } | null;
}

const LEDGER_PATH = `${STATE_DIR}/request-ledger.json`;
const MAX_RECORDS = 200;
const RETENTION_MS = 24 * 60 * 60 * 1000;

function blankStore(): StoredLedger {
  return {
    version: 2,
    salt: randomBytes(24).toString('hex'),
    records: [],
    latestAlexa: {},
    replacementRecovery: null,
  };
}

function loadStore(): StoredLedger {
  if (!existsSync(LEDGER_PATH)) return blankStore();
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as Partial<StoredLedger>;
    const storedVersion = (parsed as { version?: number }).version;
    if ((storedVersion !== 1 && storedVersion !== 2) || typeof parsed.salt !== 'string') return blankStore();
    return {
      version: 2,
      salt: parsed.salt,
      records: Array.isArray(parsed.records) ? parsed.records.filter(isRecord) : [],
      latestAlexa: parsed.latestAlexa && typeof parsed.latestAlexa === 'object'
        ? { ...parsed.latestAlexa } as Record<string, string>
        : {},
      replacementRecovery: parsed.replacementRecovery
        && typeof parsed.replacementRecovery.previousId === 'string'
        && typeof parsed.replacementRecovery.replacementId === 'string'
        && typeof parsed.replacementRecovery.identity === 'string'
        ? { ...parsed.replacementRecovery }
        : null,
    };
  } catch {
    return blankStore();
  }
}

function isRecord(value: unknown): value is RequestLedgerRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RequestLedgerRecord>;
  return typeof row.id === 'string'
    && typeof row.createdAt === 'number'
    && typeof row.updatedAt === 'number'
    && ['pending', 'resolved', 'failed', 'interrupted', 'cancelled'].includes(String(row.status))
    && (row.source === 'web' || row.source === 'alexa')
    && typeof row.requester === 'string'
    && typeof row.text === 'string';
}

const store = loadStore();
let pendingPersist = Promise.resolve();

function prune(now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  // Pending receipts connect an Alexa identity to its live resolver. Keep
  // them addressable even when a busy station fills its history window.
  let keptHistory = 0;
  store.records = store.records
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(row => {
      if (row.status === 'pending') return true;
      if (row.updatedAt < cutoff || keptHistory >= MAX_RECORDS) return false;
      keptHistory++;
      return true;
    });
  const liveIds = new Set(store.records.map(row => row.id));
  for (const [identity, id] of Object.entries(store.latestAlexa)) {
    if (!liveIds.has(id)) delete store.latestAlexa[identity];
  }
}

function persist(): Promise<void> {
  prune();
  const contents = JSON.stringify(store, null, 2) + '\n';
  const next = pendingPersist.then(async () => {
    await mkdir(dirname(LEDGER_PATH), { recursive: true });
    await writeFileAtomic(LEDGER_PATH, contents, { mode: 0o600 });
  });
  pendingPersist = next.catch(() => undefined);
  return next;
}

function updateLatestAlexa(row: RequestLedgerRecord) {
  if (!row.alexaIdentity) return;
  const currentId = store.latestAlexa[row.alexaIdentity];
  const current = currentId ? store.records.find(entry => entry.id === currentId) : null;
  // Background resolution is intentionally out of order. A late update for
  // an older request must not make RequestStatusIntent regress from the newest
  // accepted request to that older one.
  if (!current || current.id === row.id || row.createdAt >= current.createdAt) {
    store.latestAlexa[row.alexaIdentity] = row.id;
  }
}

/** Return a non-reversible key for an Alexa identity, namespaced by kind. */
export function alexaIdentityKey(value: string, kind: 'user' | 'person' = 'user'): string {
  return createHash('sha256').update(`${store.salt}:alexa:${kind}:${value}`).digest('hex');
}

export async function createPending(record: Omit<RequestLedgerRecord, 'updatedAt' | 'status'>) {
  const now = Date.now();
  const next: RequestLedgerRecord = { ...record, status: 'pending', updatedAt: now };
  const previousId = next.alexaIdentity && store.latestAlexa[next.alexaIdentity];
  store.records = [next, ...store.records.filter(row => row.id !== next.id)];
  updateLatestAlexa(next);
  try {
    await persist();
  } catch (error) {
    store.records = store.records.filter(row => row.id !== next.id);
    if (next.alexaIdentity && store.latestAlexa[next.alexaIdentity] === next.id) {
      if (previousId) store.latestAlexa[next.alexaIdentity] = previousId;
      else delete store.latestAlexa[next.alexaIdentity];
    }
    throw error;
  }
  return next;
}

// A replacement is written without an owner until the player releases the
// old request. A refusal can therefore discard it without moving "my latest".
export async function discardUnclaimedPending(id: string) {
  store.records = store.records.filter(row => !(row.id === id && row.status === 'pending' && !row.alexaIdentity));
  await persist();
}

// A durable intent bridges the player-removal side effect and the final
// receipt swap. If the controller stops or the final ledger write fails after
// removal, startup can settle both receipts from the queue's known request ids.
export async function beginReplacementRecovery(previousId: string, replacementId: string, identity: string) {
  const previous = get(previousId);
  const next = get(replacementId);
  if (!previous || !next || next.status !== 'pending' || next.alexaIdentity) {
    throw new Error('Missing receipt for replacement recovery');
  }
  if (store.replacementRecovery) throw new Error('Another replacement recovery is already in progress');
  const transaction = { previousId, replacementId, identity };
  store.replacementRecovery = transaction;
  try {
    await persist();
  } catch (error) {
    store.replacementRecovery = null;
    throw error;
  }
}

export async function abortReplacementRecovery(previousId: string, replacementId: string) {
  const current = store.replacementRecovery;
  if (!current || current.previousId !== previousId || current.replacementId !== replacementId) return;
  store.replacementRecovery = null;
  try {
    await persist();
  } catch (error) {
    store.replacementRecovery = current;
    throw error;
  }
}

// Publish both sides of a replacement in one ledger snapshot. A failed write
// rolls the in-memory mutation back too, so callers can fail closed without
// pointing the identity at a replacement the durable ledger never recorded.
export async function recordCancellation(id: string, replacement?: { id: string; identity: string }) {
  const previous = get(id);
  if (!previous) return null;
  if (!replacement) {
    return update(id, { status: 'cancelled', outcome: 'cancelled', message: 'Cancelled by listener.', reminder: null });
  }

  const next = get(replacement.id);
  if (!next || next.status !== 'pending' || next.alexaIdentity) throw new Error('Missing staged replacement');
  const previousRecord = { ...previous };
  const nextRecord = { ...next };
  const previousLatestId = store.latestAlexa[replacement.identity];
  const recovery = store.replacementRecovery;
  if (recovery && (recovery.previousId !== id || recovery.replacementId !== replacement.id || recovery.identity !== replacement.identity)) {
    throw new Error('Replacement recovery does not match the receipt swap');
  }
  next.alexaIdentity = replacement.identity;
  store.latestAlexa[replacement.identity] = next.id;
  store.replacementRecovery = null;
  try {
    return await update(id, { status: 'cancelled', outcome: 'cancelled', message: 'Cancelled by listener.', reminder: null });
  } catch (error) {
    Object.assign(previous, previousRecord);
    Object.assign(next, nextRecord);
    if (previousLatestId) store.latestAlexa[replacement.identity] = previousLatestId;
    else delete store.latestAlexa[replacement.identity];
    store.replacementRecovery = recovery;
    throw error;
  }
}

export async function update(id: string, patch: Partial<Omit<RequestLedgerRecord, 'id' | 'createdAt'>>) {
  const row = store.records.find(entry => entry.id === id);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: Date.now() });
  // Only admission changes an owner's latest pointer. A background update to
  // an older receipt may complete in the same millisecond as a replacement.
  await persist();
  return row;
}

export async function setReminder(id: string, reminder: RequestReminder): Promise<RequestLedgerRecord | null> {
  return update(id, { reminder });
}

export async function clearReminder(id: string): Promise<RequestLedgerRecord | null> {
  return update(id, { reminder: null });
}

export async function setReminderConsent(
  id: string,
  reminderConsent: RequestReminderConsent,
): Promise<RequestLedgerRecord | null> {
  return update(id, { reminderConsent });
}

export async function clearReminderConsent(id: string): Promise<RequestLedgerRecord | null> {
  return update(id, { reminderConsent: null });
}

export async function findReminderConsent(
  identity: string,
  permissionToken: string,
): Promise<{
  requestId: string;
  identity: string;
  locale: RequestReminderConsent['locale'];
  permissionToken: string;
} | null> {
  const record = store.records.find(row =>
    row.source === 'alexa'
      && row.alexaIdentity === identity
      && row.reminderConsent?.permissionToken === permissionToken,
  );
  const consent = record?.reminderConsent;
  if (!record || !consent) return null;
  if (consent.expiresAt <= Date.now()) {
    await clearReminderConsent(record.id);
    return null;
  }
  return {
    requestId: record.id,
    identity,
    locale: consent.locale,
    permissionToken: consent.permissionToken,
  };
}

export function get(id: string): RequestLedgerRecord | null {
  return store.records.find(row => row.id === id) || null;
}

export function latestForAlexa(identity: string): RequestLedgerRecord | null {
  const id = store.latestAlexa[identity];
  return id ? get(id) : null;
}

/** Mark uncertain pending work as interrupted during startup reconciliation. */
export async function interruptUnresolved(knownRequestIds: Set<string>) {
  const recordsBefore = store.records.slice();
  const snapshots = new Map(recordsBefore.map(row => [row, { ...row }]));
  const latestBefore = { ...store.latestAlexa };
  const recoveryBefore = store.replacementRecovery;
  let changed = false;
  const recovery = store.replacementRecovery;
  if (recovery) {
    const previous = get(recovery.previousId);
    const next = get(recovery.replacementId);
    if (knownRequestIds.has(recovery.previousId)) {
      // The player did not release the old request. Keep it as the listener's
      // latest and fail the staged replacement, which was never submitted.
      if (previous?.alexaIdentity) store.latestAlexa[recovery.identity] = previous.id;
      if (next) {
        next.status = 'failed';
        next.outcome = 'error';
        next.message = 'Replacement was not accepted because the previous request remained queued.';
        next.updatedAt = Date.now();
      }
    } else {
      // The old queue item is gone but the final receipt swap did not commit.
      // No replacement was submitted, so neither receipt may claim it is queued.
      if (previous) {
        previous.status = 'interrupted';
        previous.outcome = 'interrupted';
        previous.message = 'The request left the queue before its replacement could be recorded.';
        previous.reminder = null;
        previous.updatedAt = Date.now();
        store.latestAlexa[recovery.identity] = previous.id;
      }
      if (next) {
        next.status = 'interrupted';
        next.outcome = 'interrupted';
        next.message = 'Replacement was not accepted because its queue change could not be recorded.';
        next.updatedAt = Date.now();
      }
    }
    store.replacementRecovery = null;
    changed = true;
  }
  for (const row of store.records) {
    if (row.status === 'pending' && !knownRequestIds.has(row.id)) {
      row.status = 'interrupted';
      row.message = 'The controller restarted before this request reached the queue.';
      row.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) {
    try {
      await persist();
    } catch (error) {
      store.records = recordsBefore;
      for (const [row, snapshot] of snapshots) Object.assign(row, snapshot);
      store.latestAlexa = latestBefore;
      store.replacementRecovery = recoveryBefore;
      throw error;
    }
  }
}

export const ledgerPath = LEDGER_PATH;
