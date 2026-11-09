// The Hotline: one line, at most one Call on it (docs/plans/hotline.md).
//
// In memory by design. A controller restart ends the Call (there is no
// reconnect), and a Grant made before it stands on its own: it was queued the
// moment it was granted. Nothing on air ever waits on a Call.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as settings from '../settings.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import { buildPickerTools, pickerScope } from '../llm/tools.js';
import { excludesExplicit } from '../music/explicit-policy.js';
import { isNamedRequester } from '../util/request-guard.js';
import { REQUESTS_DISABLED } from '../middleware/ratelimit.js';
import * as ledger from './ledger.js';
import {
  admitCall, billableSeconds, callTimings, isBanned, lineStatus, secondsLeftToday, showAiringKey,
  type HotlineCallRefusal, type HotlineClosedReason, type HotlineState,
} from './policy.js';
import { providerReady } from './provider.js';
import type { CallOutcome, RecentCall } from './ledger.js';

export interface Call {
  id: string;
  token: string;
  deviceId: string;
  ip: string;
  name: string;
  persona: any;
  showId: string | null;
  showName: string | null;
  startedAt: number;
  capSec: number;
  wrapUpAtSec: number;
  // Accumulates every track a search tool surfaced, so a Grant can only name a
  // real id (the same `seen` map the request agent resolves against).
  picker: ReturnType<typeof buildPickerTools>;
  grant: { trackId: string; title: string; artist: string } | null;
  declined: string | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  airingKey: string;
}

let active: Call | null = null;

function lineInputs() {
  const s = settings.get() as any;
  const show = settings.resolveActiveShow();
  return {
    showOpens: show?.hotline === true,
    providerReady: providerReady(s.hotline?.provider || 'openai'),
    requestsOn: s.requests?.enabled !== false && !REQUESTS_DISABLED,
    secondsUsedToday: ledger.secondsUsedToday(),
    dailyMinutes: Number(s.hotline?.dailyMinutes) || 60,
    callActive: !!active,
  };
}

export function status(): { state: HotlineState; reason: HotlineClosedReason | null } {
  return lineStatus(lineInputs());
}

export function activeCall(): Call | null {
  return active;
}

export type StartResult = { ok: true; call: Call } | { ok: false; reason: HotlineCallRefusal };

// Admit and open a Call. The Caller's name is already cleaned by the route.
export function startCall({ deviceId, ip, name }: { deviceId: string; ip: string; name: string }): StartResult {
  const s = settings.get() as any;
  const show = settings.resolveActiveShow();
  const inputs = lineInputs();
  const airingKey = showAiringKey(show?.id, ledger.stationDay());
  const verdict = admitCall({
    ...inputs,
    banned: isBanned(ledger.bans(), { deviceId, ip }),
    deviceCallsThisShow: ledger.deviceCallsFor(airingKey, deviceId),
    callsPerDevicePerShow: Number(s.hotline?.callsPerDevicePerShow) || 1,
  });
  if (!verdict.ok) return verdict;

  const { capSec, wrapUpAtSec } = callTimings({
    maxCallSec: Number(s.hotline?.maxCallSec) || 180,
    wrapUpSec: Number(s.hotline?.wrapUpSec) || 150,
    secondsLeftToday: secondsLeftToday(inputs),
  });
  // Requests stay near-unfiltered, as on the typed request path: two hours of
  // recency so the song still ringing in their ears is not offered, and a clean
  // show hides what it would refuse.
  const recentIds = queue.recentlyPlayedIds(2);
  for (const id of queue.queuedIds()) recentIds.add(id);
  const picker = buildPickerTools(pickerScope({
    recentIds,
    // Offers identifyRequestedTrack ("the song from that film") when a web
    // search provider is ready, as on the typed request path.
    resolveReferences: true,
    excludeExplicit: excludesExplicit(settings.resolvePickShow()),
  }));
  const call: Call = {
    id: randomUUID(),
    token: randomBytes(24).toString('base64url'),
    deviceId, ip, name,
    persona: settings.getEffectivePersona(),
    showId: show?.id ?? null,
    showName: show?.name ?? null,
    startedAt: Date.now(),
    capSec, wrapUpAtSec, picker,
    grant: null, declined: null, endTimer: null, airingKey,
  };
  // The hard cap is the controller's, whatever the client does. A few seconds
  // of grace lets the DJ's goodbye finish before the line is cut.
  call.endTimer = setTimeout(() => endCall(call.id, 'cap'), (capSec + 5) * 1000);
  call.endTimer.unref?.();
  active = call;
  return { ok: true, call };
}

// The provider session is minted: the Call is real. Counted against the
// device here, not at startCall, so a provider that refuses the session does
// not spend the Caller's one Call for this show. The clock restarts here too.
export function confirmCall(call: Call): void {
  if (active !== call) return;
  call.startedAt = Date.now();
  ledger.noteCallStarted(call.airingKey, call.deviceId);
  queue.log('hotline', `${callerLabel(call)} rang the Hotline (${call.showName ? `"${call.showName}"` : 'default programming'}, up to ${call.capSec}s)`);
}

// The provider refused the session: free the line without billing or counting
// anything, as though the Caller never rang.
export function abandonCall(id: string): void {
  if (!active || active.id !== id) return;
  if (active.endTimer) clearTimeout(active.endTimer);
  active = null;
}

// The Call this token belongs to, if it is still the one on the line.
export function callFor(id: string, token: unknown): Call | null {
  if (!active || active.id !== id || typeof token !== 'string') return null;
  const a = Buffer.from(active.token);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? active : null;
}

export function secondsLeft(call: Call): number {
  return Math.max(0, call.capSec - Math.floor((Date.now() - call.startedAt) / 1000));
}

function callerLabel(call: Call): string {
  return isNamedRequester(call.name) ? `"${call.name}"` : 'An unnamed caller';
}

function outcomeOf(call: Call, endedBy: RecentCall['endedBy']): CallOutcome {
  if (call.grant) return 'granted';
  if (call.declined) return 'declined';
  return endedBy === 'error' ? 'dropped' : 'chat';
}

// End the Call, whoever ends it. Frees the line at once, bills its minutes, and
// leaves a one-line outcome in the DJ's session so the on-air DJ can mention
// it. A Grant has already written its own lines, so only a Call without one
// adds a line here. Idempotent: a second end for the same Call is a no-op.
export function endCall(id: string, endedBy: RecentCall['endedBy']): RecentCall | null {
  const call = active;
  if (!call || call.id !== id) return null;
  active = null;
  if (call.endTimer) clearTimeout(call.endTimer);
  const durationSec = billableSeconds(call.startedAt, Date.now(), call.capSec);
  const outcome = outcomeOf(call, endedBy);
  const row: RecentCall = {
    id: call.id,
    at: new Date(call.startedAt).toISOString(),
    name: call.name,
    deviceId: call.deviceId,
    ip: call.ip,
    showName: call.showName,
    durationSec,
    outcome,
    track: call.grant ? `${call.grant.title} — ${call.grant.artist}` : null,
    endedBy,
  };
  ledger.noteCallEnded(row);
  queue.log('hotline', `${callerLabel(call)} hung up after ${durationSec}s: ${outcome}${row.track ? ` (${row.track})` : ''}${endedBy === 'cap' ? ', cut at the time limit' : endedBy === 'operator' ? ', ended by the operator' : ''}`);
  if (!call.grant) {
    try {
      const who = isNamedRequester(call.name) ? `Listener "${call.name}"` : 'A listener';
      session.appendTurn({
        role: 'event', kind: 'request',
        text: call.declined
          ? `${who} rang the Hotline; you chatted on the phone and didn't queue what they asked for.`
          : `${who} rang the Hotline for a chat on the phone; nothing was queued.`,
      });
    } catch (err) {
      queue.log('error', `Hotline session line failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return row;
}
