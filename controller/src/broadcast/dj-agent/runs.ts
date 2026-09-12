// DJ-mode mini-runs: a short arc of picks that head somewhere together rather
// than each being chosen from scratch. Holds the run state and decides, per
// track, whether one starts, continues or ends.

import * as settings from '../../settings.js';
import * as library from '../../music/library.js';
import * as mix from '../../music/mix.js';
import * as journey from '../../music/journey.js';
import { shiftOnsetMs } from '../../music/silence-trim.js';
import { shuffle } from '../../util/shuffle.js';
import { energyForDaypart } from '../../context.js';

// A tempo/key target across 2-3 consecutive picks; while active the pool
// re-rank anchors to it rather than the current track. Module-level state: one
// station, one run at a time, cleared when it runs out or the persona leaves
// DJ mode.
//
// `waypoints`/`step` are the optional sonic-journey overlay: a path of CLAP
// vectors toward a destination vibe, one consumed per pick as the audio-KNN
// anchor. Absent on a plain tempo/key run.
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

// How many candidate tracks to average for a destination-vibe centroid. Small
// on purpose: a large sample averages out to the energy bucket's mean every
// time, so every journey heads for the same fixed point. It must be 8 tracks
// WITH audio vectors, which is why the sampling below probes rather than
// slicing — CLAP coverage is normally partial.
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

// Overlay a sonic journey on a freshly-started run. Destination is a
// daypart-appropriate energy bucket's centroid, so the run drifts the same way
// the tempo/key target nudges. No-op when the current track or the destination
// has no audio coverage. `totalSteps` is how many picks the run influences.
function maybeAttachJourney(rs: RunState, current: any, totalSteps: number): void {
  const startId = current?.id;
  if (!startId) return;
  try {
    const destEnergy = energyForDaypart().speed >= 1 ? 'high' : 'low';
    const bucket = shuffle(library.songsByEnergy(destEnergy).map((s: any) => s.id));
    // Draw ids the audio index actually covers, rather than slicing blind and
    // letting audioCentroid average around the gaps.
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

// Advance the mini-run for this pick. A null rankTarget or audioWaypoint means
// anchor to the current track as usual. DJ mode with an analysed track only.
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
  // This pick plus the `extra` that follow → extra + 1 waypoints.
  maybeAttachJourney(runState, current, extra + 1);
  return { rankTarget: target, audioWaypoint: takeWaypoint(runState) };
}

export function runActive(): boolean {
  return !!(runState && runState.remaining > 0);
}

// The operator discovery bench needs to show the same journey source that the
// next live pick would receive. Peek only: advancing is owned by advanceRun()
// when a real track event begins.
export function activeJourneyWaypoint(): number[] | null {
  if (!runState || runState.remaining <= 0 || !runState.waypoints?.length) return null;
  const idx = Math.min(runState.step ?? 0, runState.waypoints.length - 1);
  return runState.waypoints[idx];
}
