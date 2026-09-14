// The voice-kind registry the DJ recap reads through. The fixed channels are
// declared here; skills/loader.ts registers every loaded skill kind at load
// time via registerSkillKinds(), so a new skill is recapped without editing
// this file.
//
// Part of the queue/ split - see ../queue.ts, which owns the Queue class.



// Voice kinds the DJ recap remembers. The fixed channels are always present;
// every skill kind (built-in + custom) is registered at skill-load time via
// registerSkillKinds() — so a new skill is recapped without editing this list.
// 'handoff' (the two-voice persona mic-pass) counts too, so the incoming DJ's
// next segments don't echo the greeting's opener.
export const VOICE_KINDS = new Set(['dj-speak', 'link', 'station-id', 'hourly-check', 'handoff', 'banter']);
// The intro channels tied to a track start rather than the wall clock — the
// standalone-talk-break clock (getLastTalkBreakAt) skips them.
export const TRACK_TIED_KINDS = new Set(['dj-speak', 'link']);
// How long a boundary-deferred segment may wait for a track start before it's
// dropped as stale (its prompt context baked in the clock at generation time).
// Comfortably past a long album cut, well short of the next ident sounding odd.
export const PENDING_VOICE_MAX_AGE_MS = 20 * 60_000;
// The minimal description of a segment already rendered and waiting for the
// next track boundary: what it is, and when it was queued. Declared beside the
// age limit rather than at either end, because Queue produces it and
// broadcast/talk-scheduler.ts consumes it, and a second spelling of the shape
// would drift from the constant that gives `queuedAt` its meaning.
export type PendingTalk = { kind: string; queuedAt: number };
// The two questions asked about that clip's finite life, named once so neither
// caller re-spells the arithmetic. Queue asks the first at a track start, to
// drop a clip that waited too long; the talk scheduler asks the second to
// decide how long a pending clip may hold a gap-gated row (#1539).
//
// Two functions rather than one, deliberately: the drop is strictly PAST the
// limit while the scheduler needs the remaining duration, and deriving either
// from the other would move the drop boundary by a millisecond.
export function pendingVoiceStale(queuedAt: number, nowMs: number): boolean {
  return nowMs - queuedAt > PENDING_VOICE_MAX_AGE_MS;
}
// Clamped at both ends: a clock adjustment that stamps a clip in the future
// must not buy it more than the one lifetime the constant allows.
export function pendingVoiceValidForMs(queuedAt: number, nowMs: number): number {
  return Math.max(0, PENDING_VOICE_MAX_AGE_MS - Math.max(0, nowMs - queuedAt));
}
// Kinds whose recap entries are de-duped. Skills are added at load time too.
// 'handoff' is deliberately NOT deduped — its two lines (sign-off + greeting)
// are distinct utterances by different voices.
export const DEDUPE_KINDS = new Set(['station-id', 'hourly-check']);
export const KIND_LABEL: Record<string, string> = {
  'dj-speak': 'intro',
  'link': 'link',
  'station-id': 'ident',
  'hourly-check': 'hourly',
  'handoff': 'handoff',
  'banter': 'banter',
};

// Register the loaded skill kinds (built-in + custom) as recap voice/dedupe
// kinds. Called by skills/loader.js after each (re)load; idempotent (Sets).
export function registerSkillKinds(kinds: string[]): void {
  for (const k of kinds) {
    if (!k) continue;
    VOICE_KINDS.add(k);
    DEDUPE_KINDS.add(k);
  }
}


