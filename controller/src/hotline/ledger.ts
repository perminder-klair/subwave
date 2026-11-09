// The Hotline's own durable state, `state/hotline.json`: the station day's
// minutes, each device's Calls per show airing, the operator's Hotline bans and
// a short list of recent Call outcomes for the admin page. No audio and no
// transcript are ever kept (docs/plans/hotline.md, "Memory and privacy").
//
// The minutes and per-device counts roll on the station's own clock day. A
// read that finds a stale day starts the new one; nothing else resets them.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { STATE_DIR } from '../config.js';
import { createSerialFileWriter } from '../util/atomic-file.js';
import * as time from '../time.js';
import type { HotlineBan } from './policy.js';

const LEDGER_PATH = `${STATE_DIR}/hotline.json`;
const RECENT_MAX = 50;
const BANS_MAX = 500;

export type CallOutcome = 'granted' | 'declined' | 'chat' | 'dropped';

export interface RecentCall {
  id: string;
  at: string;
  name: string;
  deviceId: string;
  ip: string;
  showName: string | null;
  durationSec: number;
  outcome: CallOutcome;
  // "Title — Artist" for a Grant; null otherwise.
  track: string | null;
  endedBy: 'caller' | 'dj' | 'cap' | 'operator' | 'restart' | 'error';
}

interface LedgerData {
  day: string;
  secondsUsed: number;
  deviceCalls: Record<string, Record<string, number>>;
  bans: HotlineBan[];
  recent: RecentCall[];
}

const write = createSerialFileWriter(LEDGER_PATH);
let data: LedgerData | null = null;

function empty(day: string): LedgerData {
  return { day, secondsUsed: 0, deviceCalls: {}, bans: [], recent: [] };
}

// Lenient like settings load(): a hand-edited or torn file coerces to an empty
// day rather than wedging the Hotline, and bans and recent rows survive any
// field they can.
function coerce(raw: any, today: string): LedgerData {
  const d = empty(today);
  if (!raw || typeof raw !== 'object') return d;
  if (Array.isArray(raw.bans)) {
    d.bans = raw.bans.filter((b: any) => b && typeof b.id === 'string').slice(-BANS_MAX).map((b: any) => ({
      id: b.id, deviceId: String(b.deviceId || ''), ip: String(b.ip || ''), name: String(b.name || ''), at: String(b.at || ''),
    }));
  }
  if (Array.isArray(raw.recent)) d.recent = raw.recent.filter((r: any) => r && typeof r.id === 'string').slice(0, RECENT_MAX);
  if (raw.day === today) {
    d.secondsUsed = Number.isFinite(raw.secondsUsed) ? Math.max(0, raw.secondsUsed) : 0;
    if (raw.deviceCalls && typeof raw.deviceCalls === 'object') d.deviceCalls = raw.deviceCalls;
  }
  return d;
}

function today(): string {
  return time.zonedISODate(new Date());
}

function current(): LedgerData {
  const day = today();
  if (!data) {
    let raw: unknown = null;
    try { raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')); } catch { /* fresh station */ }
    data = coerce(raw, day);
  }
  if (data.day !== day) data = { ...data, day, secondsUsed: 0, deviceCalls: {} };
  return data;
}

function save(): void {
  write(JSON.stringify(current(), null, 2)).catch(err => {
    console.error(`[hotline] ledger save failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function stationDay(): string {
  return current().day;
}

export function secondsUsedToday(): number {
  return current().secondsUsed;
}

export function deviceCallsFor(airingKey: string, deviceId: string): number {
  return current().deviceCalls[airingKey]?.[deviceId] ?? 0;
}

// Counted when the Call connects, so a device can't dodge the limit by
// hanging up early.
export function noteCallStarted(airingKey: string, deviceId: string): void {
  const d = current();
  const byDevice = (d.deviceCalls[airingKey] ||= {});
  byDevice[deviceId] = (byDevice[deviceId] ?? 0) + 1;
  save();
}

export function noteCallEnded(row: RecentCall): void {
  const d = current();
  d.secondsUsed += row.durationSec;
  d.recent = [row, ...d.recent].slice(0, RECENT_MAX);
  save();
}

export function bans(): HotlineBan[] {
  return [...current().bans];
}

export function recentCalls(): RecentCall[] {
  return [...current().recent];
}

export function addBanFromCall(callId: string): HotlineBan | null {
  const d = current();
  const row = d.recent.find(r => r.id === callId);
  if (!row) return null;
  const existing = d.bans.find(b => b.deviceId === row.deviceId && b.ip === row.ip);
  if (existing) return existing;
  const ban: HotlineBan = { id: randomUUID(), deviceId: row.deviceId, ip: row.ip, name: row.name, at: new Date().toISOString() };
  d.bans = [...d.bans, ban].slice(-BANS_MAX);
  save();
  return ban;
}

export function removeBan(id: string): boolean {
  const d = current();
  const before = d.bans.length;
  d.bans = d.bans.filter(b => b.id !== id);
  if (d.bans.length === before) return false;
  save();
  return true;
}

// Tests only: forget the in-memory copy so the next read loads from disk.
export function _resetForTests(): void {
  data = null;
}
