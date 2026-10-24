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
  store.records = store.records
    .filter(row => row.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECORDS);
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

/** Return a non-reversible key for an Alexa account identifier. */
export function alexaIdentityKey(userId: string): string {
  return createHash('sha256').update(`${store.salt}:alexa:${userId}`).digest('hex');
}

export async function createPending(record: Omit<RequestLedgerRecord, 'updatedAt' | 'status'>) {
  const now = Date.now();
  const next: RequestLedgerRecord = { ...record, status: 'pending', updatedAt: now };
  store.records = [next, ...store.records.filter(row => row.id !== next.id)];
  updateLatestAlexa(next);
  await persist();
  return next;
}

export async function update(id: string, patch: Partial<Omit<RequestLedgerRecord, 'id' | 'createdAt'>>) {
  const row = store.records.find(entry => entry.id === id);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: Date.now() });
  updateLatestAlexa(row);
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
  let changed = false;
  for (const row of store.records) {
    if (row.status === 'pending' && !knownRequestIds.has(row.id)) {
      row.status = 'interrupted';
      row.message = 'The controller restarted before this request reached the queue.';
      row.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) await persist();
}

export const ledgerPath = LEDGER_PATH;
