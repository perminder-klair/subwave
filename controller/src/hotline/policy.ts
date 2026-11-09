// Every Hotline decision, pure (docs/plans/hotline.md). The routes and the line
// only read state, ask here, and act: whether the line is open, whether a Call
// may connect, how long it may run, what it costs, and which voice answers. A
// second copy of any of these checks is the bug.

export type HotlineState = 'closed' | 'open' | 'busy';

// Why a closed line is closed, in the order they are checked: the first that
// applies is the one an operator is told.
export type HotlineClosedReason = 'provider' | 'requests' | 'show' | 'minutes';

export interface HotlineLineInputs {
  // The show on air has its `hotline` toggle on.
  showOpens: boolean;
  // The provider's key is set (the Hotline cannot answer without it).
  providerReady: boolean;
  // Requests are on station-wide: a Call that cannot Grant is only a chat.
  requestsOn: boolean;
  secondsUsedToday: number;
  dailyMinutes: number;
  callActive: boolean;
}

export function lineStatus(i: HotlineLineInputs): { state: HotlineState; reason: HotlineClosedReason | null } {
  if (!i.providerReady) return { state: 'closed', reason: 'provider' };
  if (!i.requestsOn) return { state: 'closed', reason: 'requests' };
  if (!i.showOpens) return { state: 'closed', reason: 'show' };
  if (secondsLeftToday(i) <= 0) return { state: 'closed', reason: 'minutes' };
  if (i.callActive) return { state: 'busy', reason: null };
  return { state: 'open', reason: null };
}

export function secondsLeftToday(i: { secondsUsedToday: number; dailyMinutes: number }): number {
  return Math.max(0, i.dailyMinutes * 60 - i.secondsUsedToday);
}

export type HotlineCallRefusal = HotlineClosedReason | 'busy' | 'banned' | 'device-limit' | 'too-short';

// A Call needs at least this much of the day's minutes left to be worth
// connecting: less, and the DJ is saying goodbye before hello.
export const MIN_CALL_SEC = 45;

export function admitCall(i: HotlineLineInputs & {
  banned: boolean;
  deviceCallsThisShow: number;
  callsPerDevicePerShow: number;
}): { ok: true } | { ok: false; reason: HotlineCallRefusal } {
  const line = lineStatus(i);
  if (line.state === 'closed') return { ok: false, reason: line.reason! };
  // A banned device is told the line is closed to it before it learns anything
  // about who else is on the line.
  if (i.banned) return { ok: false, reason: 'banned' };
  if (line.state === 'busy') return { ok: false, reason: 'busy' };
  if (i.deviceCallsThisShow >= i.callsPerDevicePerShow) return { ok: false, reason: 'device-limit' };
  if (secondsLeftToday(i) < MIN_CALL_SEC) return { ok: false, reason: 'too-short' };
  return { ok: true };
}

// How long this Call may run, and when the DJ is told to wrap up. The day's
// remaining minutes cap a Call as hard as `maxCallSec` does, and the wrap-up
// always lands before the cap, with time to say goodbye.
export function callTimings(i: { maxCallSec: number; wrapUpSec: number; secondsLeftToday: number }): {
  capSec: number;
  wrapUpAtSec: number;
} {
  const capSec = Math.max(0, Math.min(i.maxCallSec, Math.floor(i.secondsLeftToday)));
  const wrapUpAtSec = Math.max(0, Math.min(i.wrapUpSec, capSec - 20));
  return { capSec, wrapUpAtSec };
}

// What a Call costs against the day's minutes: its real length, never more than
// its cap (the line is cut there), and never less than a second for a Call that
// connected at all.
export function billableSeconds(startedAtMs: number, endedAtMs: number, capSec: number): number {
  const elapsed = Math.ceil(Math.max(0, endedAtMs - startedAtMs) / 1000);
  return Math.max(1, Math.min(elapsed, capSec));
}

// The per-device limit counts Calls per show airing: the show's id within the
// station day, so the same show tomorrow is a fresh airing.
export function showAiringKey(showId: string | null | undefined, stationDay: string): string {
  return `${stationDay}:${showId || 'default'}`;
}

export interface HotlineBan { id: string; deviceId: string; ip: string; name: string; at: string }

// A ban keys on the device id OR the address it called from: either alone is
// easy to shed, so either matching is enough.
export function isBanned(bans: readonly HotlineBan[], who: { deviceId: string; ip: string }): boolean {
  return bans.some(b => (b.deviceId && b.deviceId === who.deviceId) || (b.ip && b.ip === who.ip));
}

// OpenAI Realtime's own voices. A persona on OpenAI TTS whose voice is one of
// these sounds like itself on the phone; anyone else gets the operator's pick
// or the provider default.
export const OPENAI_REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;
export const OPENAI_REALTIME_DEFAULT_VOICE = 'marin';

export function realtimeVoiceFor(i: {
  configured: string;
  personaProvider: string | null;
  personaVoice: string | null;
}): string {
  const configured = i.configured.trim().toLowerCase();
  if (configured) return configured;
  const voice = String(i.personaVoice || '').trim().toLowerCase();
  if (i.personaProvider === 'openai' && (OPENAI_REALTIME_VOICES as readonly string[]).includes(voice)) return voice;
  return OPENAI_REALTIME_DEFAULT_VOICE;
}

// What the DJ is told when a Grant is refused, as a reason code it puts in its
// own words. Never copy for the Caller: the call model speaks in persona.
export type GrantRefusal =
  | 'already-granted' | 'unknown-track' | 'clean-show' | 'cooldown' | 'already-queued'
  | 'blocked' | 'requests-closed' | 'queue-full' | 'one-pending' | 'rate-limited' | 'call-ended';

export const GRANT_REFUSAL_NOTES: Record<GrantRefusal, string> = {
  'already-granted': 'You have already granted this caller their one track on this call.',
  'unknown-track': 'That id did not come from your search results. Search again and use an exact id from the results.',
  'clean-show': "That track can't play on this show (it's tagged explicit and this is a clean show). Offer something else.",
  'cooldown': 'That track played recently, so it is resting. Offer something else.',
  'already-queued': 'That track is already coming up. Tell the caller it is on the way already.',
  'blocked': "That track isn't available. Offer something else without explaining why.",
  'requests-closed': 'Requests have just closed on the station, so you cannot queue anything now. Apologise and chat instead.',
  'queue-full': 'The request queue is full right now, so you cannot queue anything on this call. Apologise and suggest they try again later.',
  'one-pending': "This caller already has a request waiting to play; it has to air before they can get another.",
  'rate-limited': 'The request line is too busy to take another one right now. Apologise and suggest they try again later.',
  'call-ended': 'The call has ended.',
};
