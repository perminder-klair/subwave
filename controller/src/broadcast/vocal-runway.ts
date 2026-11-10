// Resolve vocal onset onto the silence-trimmed playback timeline. Keep measured onset,
// instrumental Infinity, and unknown null distinct; the queue and intro budget share this
// composition. #1622, scripts/vocal-runway.test.ts.

import * as library from '../music/library.js';
import * as silenceTrim from '../music/silence-trim.js';
import { rampBudgetMs } from './bed-policy.js';

// The band inside which a measured runway BINDS, shared with the intro budget
// (llm/internal/prompts/intro-budget.ts imports both).
//
// FLOOR: below this the energy-heuristic `intro_ms` is noise, which is why the
// budget is lenient down there — but a MEASURED vocal entry under the floor is
// the singer genuinely starting immediately, and that is the case both readers
// refuse rather than excuse.
export const VOCAL_RUNWAY_FLOOR_MS = 2500;
// CEILING: this much runway is not a constraint. Above it the intro budget
// returns its line unchanged, and a boundary is never refused for it.
export const VOCAL_RUNWAY_CEILING_MS = 18000;

// What a runway can be read off. `vocalRanges` rides the track object when a
// pick carries fresh analysis; a queued item holds only id/title/artist, so the
// library row is the fallback — the same precedence silence-trim and
// queue.mixAnalysisFor use, so a track carrying fresh analysis never gets a
// stale answer from the DB.
export interface RunwayTrack {
  id?: string | null;
  vocalRanges?: { startMs: number }[] | null;
  duration?: number | string | null;
  durationSec?: number | string | null;
}

// The runway for a track, on the trimmed timeline. Three-state, passed through
// intact: a finite number of ms, Infinity for an analysed instrumental, null
// for a track nothing has measured. `shiftOnsetMs` is applied only to the
// finite case — it answers null for anything else, which would flatten
// Infinity into "unknown" and lose the one state that means "talk as long as
// you like".
export function vocalRunwayMs(track: RunwayTrack | null | undefined): number | null {
  if (!track) return null;
  const ranges = track.vocalRanges ?? (track.id ? library.get(track.id)?.vocalRanges ?? null : null);
  const raw = rampBudgetMs({ vocalRanges: ranges as { startMs: number }[] | null });
  if (raw == null || !Number.isFinite(raw)) return raw;
  return silenceTrim.shiftOnsetMs(track, raw);
}

// May a rendered spoken segment take THIS track's head?
//
// The lever here is TIMING, not text, and that is forced by the order things
// happen in. A pick's link is written for a known song and trimmed
// (enforceIntroBudget) before it is rendered. A scheduled segment is spoken
// into a WAV before the boundary it will take is even known — announce() renders
// and only then discovers the talk-air scope, announceAtNextTrack renders NOW
// precisely to keep TTS latency off the air path, and airPendingVoice can hold
// the result across several boundaries afterwards. By the time the incoming
// track is a fact there is no text left to trim, so a segment that would
// outlast the runway does what a segment already does when a boundary is busy
// (boundaryCarriesTrackVoice): it keeps its slot and waits for the next one.
// Postpone, never cancel — and never regenerate, the rendered WAV just waits.
//
// `voiceMs` is queue.speechDurationMs — the clip plus the lead-in and duck-tail
// padding, i.e. what the voice chain actually holds the air for. Same figure
// the bed decision budgets a link at, so the two agree about one clip.
//
// The bands, in the order they are asked:
//
//   clip ≥ CEILING       → yes, and this is asked FIRST. No runway in the
//                          binding band can hold a clip that long, so refusing
//                          boundaries for it is a guaranteed loss: it would
//                          ride the pending slot to PENDING_VOICE_MAX_AGE_MS
//                          and be dropped unaired, which is strictly worse than
//                          the talk-over it was going to do. A long segment
//                          (a news read) keeps today's behaviour exactly.
//   runway null          → yes. Un-analysed tracks are never constrained —
//                          the same posture the intro budget takes, and what
//                          makes a station with no Demucs pass byte-identical.
//   runway Infinity      → yes. An analysed instrumental has nothing to trample.
//   runway < FLOOR       → no. A measured vocal entry that early is the failure
//                          this exists to prevent; no clip is short enough.
//   otherwise            → the clip must finish inside the runway.
//
// The intro budget's matching UPPER guard (a runway ≥ CEILING constrains
// nothing) is deliberately not restated as a branch here: it is subsumed by the
// clip ceiling above, since any clip that reaches the comparison is shorter than
// CEILING and therefore shorter than a runway at or past it. Adding it back
// would be a branch that cannot run.
export function segmentFitsRunway(voiceMs: number, runwayMs: number | null): boolean {
  if (!Number.isFinite(voiceMs) || voiceMs <= 0) return true;
  if (voiceMs >= VOCAL_RUNWAY_CEILING_MS) return true;
  if (runwayMs == null) return true;
  if (!Number.isFinite(runwayMs)) return true;
  if (runwayMs < VOCAL_RUNWAY_FLOOR_MS) return false;
  return voiceMs <= runwayMs;
}
