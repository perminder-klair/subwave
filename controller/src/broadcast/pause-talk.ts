// Pure helpers for pause-then-talk (issue #551).
//
// Ducking stays the default for short asides. When the active show opts in
// (`pauseTalk`) and a rendered spoken segment runs longer than a global
// threshold, the segment is not aired ducked over the music — instead the
// current song plays to its natural end, the DJ speaks in the clear, and the
// next song ramps in briefly under the sign-off. The clip rides the music
// timeline as its own annotated `subwave_kind="talk"` item through the same
// `next.txt` seam beds use.
//
// Everything here is side-effect-free so it can be unit-pinned
// (scripts/pause-talk.test.ts). The stateful slot, the timeline insertion, and
// the WAV padding live in broadcast/queue.ts + audio/wav-pad.ts.

import { escAnnotate } from '../music/subsonic.js';

// The next song ramps in under the DJ's final words — classic radio. Constant
// in v1 (not operator-tunable). The talk clip's OWN exit crossfade.
export const TALK_EXIT_CROSS_SEC = 1.5;

// A pending talk clip older than this is dropped rather than aired late — a
// 20-minute-old "news right now" clip landing mid-song is worse than silence.
// Mirrors PENDING_VOICE_MAX_AGE_MS; well inside the 1-hour Piper cleanup window
// so the WAV can't be reaped while it waits.
export const PAUSE_TALK_MAX_AGE_MS = 20 * 60_000;

// Small breath after the outgoing song has fully faded, before the first word.
export const TALK_HEAD_PAD_MS = 400;
// Guarantees the clip's exit fade eats silence, never the DJ's last word.
export const TALK_TAIL_PAD_MS = 300;

// The gap-vs-duck decision. Made in queue.announce() after speak() returns —
// the only place the clip's true length is known (text-length heuristics vary
// by engine/persona/daypart). A null wavMs means a non-WAV clip (the cloud
// engine's mp3), which the PCM padder can't touch → duck.
export function wantsPauseTalk(opts: {
  enabled: boolean;      // resolveActiveShow()?.pauseTalk === true
  gapEligible: boolean;  // caller opted in (skill segments only, v1)
  wavMs: number | null;  // wavDurationMs(wavPath); null for non-WAV (cloud mp3)
  thresholdSec: number;  // settings.dj.pauseTalkMinSeconds
}): boolean {
  const { enabled, gapEligible, wavMs, thresholdSec } = opts;
  if (!enabled || !gapEligible) return false;
  if (wavMs == null) return false;
  const threshMs = Math.max(0, thresholdSec) * 1000;
  return wavMs >= threshMs;
}

// Head/tail silence to pad onto the clip. Head covers the outgoing song's exit
// fade (entryCrossSec, governed by the PREVIOUS song's already-sent
// liq_cross_duration) plus a breath; tail covers the clip's own exit fade plus
// a margin.
export function padTimesFor({
  entryCrossSec,
  exitCrossSec = TALK_EXIT_CROSS_SEC,
}: {
  entryCrossSec: number;
  exitCrossSec?: number;
}): { headMs: number; tailMs: number } {
  const entry = Number.isFinite(entryCrossSec) ? Math.max(0, entryCrossSec) : 0;
  const exit = Number.isFinite(exitCrossSec) ? Math.max(0, exitCrossSec) : 0;
  return {
    headMs: Math.round(entry * 1000 + TALK_HEAD_PAD_MS),
    tailMs: Math.round(exit * 1000 + TALK_TAIL_PAD_MS),
  };
}

// Belt-and-suspenders: a clip shorter than its own entry cross would glitch
// cross(). With the >= threshold this never fires; it guards tiny thresholds.
// paddedMs is the clip length AFTER head/tail padding.
export function talkTooShort(paddedMs: number, entryCrossSec: number): boolean {
  const entry = Number.isFinite(entryCrossSec) ? Math.max(0, entryCrossSec) : 0;
  return paddedMs <= (entry + 5) * 1000;
}

// Build the timeline URI for the padded talk clip. subwave_kind="talk" keeps it
// orthogonal to beds (which gate real behaviour on their kind). No liq_cue_out
// — play the whole clip. liq_amplify only when non-zero, same convention as
// voiceUriWithGain.
export function talkUri(
  paddedPath: string,
  { exitCrossSec = TALK_EXIT_CROSS_SEC, gainDb = 0 }: { exitCrossSec?: number; gainDb?: number } = {},
): string {
  const fields = [
    'subwave_kind="talk"',
    `liq_cross_duration="${escAnnotate(exitCrossSec.toFixed(2))}"`,
  ];
  if (gainDb !== 0) fields.push(`liq_amplify="${escAnnotate(`${gainDb} dB`)}"`);
  return `annotate:${fields.join(',')}:${paddedPath}`;
}
