// DJ-mode mini-runs: a short arc of picks that head somewhere together rather
// than each being chosen from scratch. Holds the run state and decides, per
// track, whether one starts, continues or ends.
//
// Part of the dj-agent/ split - see ../dj-agent.ts for the pick/request runs.

import * as settings from '../../settings.js';
import * as library from '../../music/library.js';
import * as mix from '../../music/mix.js';
import * as journey from '../../music/journey.js';
import { shiftOnsetMs } from '../../music/silence-trim.js';
import { shuffle } from '../../util/shuffle.js';
import { energyForDaypart } from '../../context.js';

// --- Feature 4: DJ-mode mini-runs ------------------------------------------
// A short, deliberate tempo/key journey across 2-3 consecutive picks. While a
// run is active the pool re-rank is anchored to the run target (not just the
// current track), and the link patter acknowledges the run. State is module-
// level — one station, one run at a time. Cleared when it runs out or when the
// active persona isn't in DJ mode.
//
// Phase 2 overlay — a SONIC JOURNEY. When the audio (CLAP) index is populated,
// a run can also carry a sequence of waypoint vectors through the audio space
// toward a destination vibe; each pick consumes one waypoint, handed to the
// picker as the audio-KNN anchor so the pool drifts toward the destination
// while the tempo/key re-rank still applies. `waypoints`/`step` are absent on a
// plain tempo/key run (no audio index, or the journey couldn't be built), in
// which case the run behaves exactly as it did before.
interface RunState {
  bpm: number | null;
  key: string | null;
  remaining: number;
  waypoints?: number[][];
  step?: number;
}
let runState: RunState | null = null;

// What advanceRun hands back per pick: the tempo/key re-rank target (feature 4)
// and, when a sonic journey is active, the current waypoint vector for the
// picker's audio anchor. Either may be null independently.
interface RunStep {
  rankTarget: { bpm: number | null; key: string | null } | null;
  audioWaypoint: number[] | null;
}

// How many candidate tracks to average for a destination-vibe centroid. Capped
// so a big energy bucket doesn't turn the centroid into one getAudioVector read
// per track in the library on every run start.
// Small on purpose: the destination is the CENTROID of this sample, and a
// 60-track sample of an energy bucket averages out to ~the bucket's mean every
// time — journeys kept heading for the same two fixed points in audio space
// (one per direction). Eight random tracks give a centroid that genuinely
// varies run to run while still smoothing out any single outlier.
//
// Eight tracks WITH audio vectors, which is why the sampling below probes
// rather than just slicing. audioCentroid silently drops ids the CLAP index
// doesn't cover, and partial coverage is the normal state (analysis backfills
// over days) — so on a 20 %-covered library a blind slice of 8 averages ~1.6
// vectors, lands on a single arbitrary track's "centroid" more often than not,
// and comes back empty (journey silently dropped) about one run in six.
const JOURNEY_DEST_SAMPLE = 8;
// Ceiling on those probes, so a bucket with no audio coverage at all costs a
// bounded number of indexed lookups instead of a walk over the whole bucket.
const JOURNEY_DEST_PROBE_LIMIT = JOURNEY_DEST_SAMPLE * 25;

// Consume the next waypoint from a run (clamped to the last one), advancing the
// step cursor. null when the run carries no journey.
function takeWaypoint(rs: RunState): number[] | null {
  if (!rs.waypoints || rs.waypoints.length === 0) return null;
  const idx = Math.min(rs.step ?? 0, rs.waypoints.length - 1);
  rs.step = idx + 1;
  return rs.waypoints[idx];
}

// Try to overlay a sonic journey on a freshly-started run. Destination is a
// daypart-appropriate energy bucket's centroid (brisker daypart → toward the
// high-energy sound, mellower → toward the low-energy sound), so the run drifts
// in the same direction the tempo/key target already nudges. No-op (leaves the
// run a plain tempo/key run) when the current track or the destination has no
// audio coverage. `totalSteps` is the number of picks the run will influence.
function maybeAttachJourney(rs: RunState, current: any, totalSteps: number): void {
  const startId = current?.id;
  if (!startId) return;
  try {
    const destEnergy = energyForDaypart().speed >= 1 ? 'high' : 'low';
    const bucket = shuffle(library.songsByEnergy(destEnergy).map((s: any) => s.id));
    // Draw JOURNEY_DEST_SAMPLE ids the audio index actually covers, rather than
    // slicing blind and letting audioCentroid discover the gaps by averaging
    // around them. Same sample size, honest denominator.
    const destIds: string[] = [];
    for (let i = 0; i < bucket.length && i < JOURNEY_DEST_PROBE_LIMIT; i++) {
      if (destIds.length >= JOURNEY_DEST_SAMPLE) break;
      if (library.hasAudioVector(bucket[i])) destIds.push(bucket[i]);
    }
    if (destIds.length === 0) return;
    const j = journey.buildJourney({ startId, endIds: destIds, steps: totalSteps });
    if (!j) return;
    rs.waypoints = j.waypoints;
    rs.step = 0;
  } catch {
    // Journey is a best-effort enhancement — never let it break a pick.
  }
}

// Resolve {bpm, key} for a track via the library DB (queued/agent picks carry
// only id/title/artist). library.bpmKeyFor prefers the analyzer's numbers and
// treats Navidrome's ID3-derived `bpm: 0` as unknown (#862).
function analysisOf(track: any): { bpm: number | null; key: string | null } {
  return library.bpmKeyFor(track);
}

// Resolve a track's measured intro runway (ms), for the talk-within-the-intro
// budget enforcement.
export function introMsOf(track: any): number | null {
  const raw = track?.introMs != null ? track.introMs : (track?.id ? library.get(track.id)?.introMs ?? null : null);
  // Trimmed timeline — see intro-budget.introMsFor for why.
  return shiftOnsetMs(track, raw);
}

// Probability of STARTING a run on a given pick, by chattiness. Quiet personas
// never start one; a run is a presence behaviour like the rest of DJ mode.
function runStartProbability(): number {
  const f = settings.effectiveFrequency();
  if (f === 'aggressive') return 0.5;
  if (f === 'chatty') return 0.4;
  if (f === 'moderate') return 0.3;
  return 0;
}

// Advance the mini-run state for this pick and return the re-rank target +
// (optional) sonic-journey waypoint to use. rankTarget null means "anchor the
// tempo/key re-rank to the current track as usual"; audioWaypoint null means
// "no journey — the audio source anchors to the current track". Only does
// anything in DJ mode with an analysed current track.
const NO_RUN: RunStep = { rankTarget: null, audioWaypoint: null };

export function advanceRun(djMode: boolean, current: any): RunStep {
  if (!djMode) { runState = null; return NO_RUN; }
  if (runState && runState.remaining > 0) {
    runState.remaining--;
    const waypoint = takeWaypoint(runState);
    if (runState.remaining <= 0) {
      const rankTarget = { bpm: runState.bpm, key: runState.key };
      runState = null;
      return { rankTarget, audioWaypoint: waypoint };
    }
    return { rankTarget: { bpm: runState.bpm, key: runState.key }, audioWaypoint: waypoint };
  }
  // No active run — maybe start one off the current track.
  const cur = analysisOf(current);
  if ((cur.bpm == null && cur.key == null) || Math.random() >= runStartProbability()) return NO_RUN;
  const target = mix.pickRunTarget(cur, energyForDaypart());
  if (!target) return NO_RUN;
  const extra = 1 + Math.floor(Math.random() * 2); // 1-2 more picks after this
  runState = { bpm: target.bpm, key: target.key, remaining: extra };
  // Overlay a sonic journey if the audio index can support one (this pick + the
  // `extra` that follow → extra + 1 total waypoints). No-op otherwise.
  maybeAttachJourney(runState, current, extra + 1);
  return { rankTarget: target, audioWaypoint: takeWaypoint(runState) };
}

export function runActive(): boolean {
  return !!(runState && runState.remaining > 0);
}

