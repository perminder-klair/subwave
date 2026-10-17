// DJ-mode mini-runs: a short arc of picks that head somewhere together rather
// than each being chosen from scratch. Holds the run state and decides, per
// track, whether one starts, continues or ends.

import * as settings from '../../settings.js';
import * as library from '../../music/library.js';
import * as mix from '../../music/mix.js';
import * as journey from '../../music/journey.js';
import { journeyDestinationIds, type JourneyShow } from '../../music/journey-destination.js';
import { shiftOnsetMs } from '../../music/silence-trim.js';
import { energyForDaypart } from '../../context.js';

// A tempo/key target across 2-3 consecutive picks; while active the pool
// re-rank anchors to it rather than the current track. Module-level state: one
// station, one run at a time, cleared when it runs out, the persona leaves DJ
// mode, or the show the picks are FOR changes (#1911).
//
// `showKey` is that show. A run belongs to the show it started in: the next
// host must not inherit the previous host's arc, and a journey's destination
// was drawn from inside the show that started it. It is compared per pick,
// against the show resolved at the pick's own air time, rather than cleared by
// the session roll — the first pick of an incoming show is made under the
// look-ahead clock BEFORE the live session rolls, so a roll-time reset would
// land one pick too late, on exactly the pick the issue is about.
//
// `waypoints`/`step` are the optional sonic-journey overlay: a path of CLAP
// vectors toward a destination vibe, one consumed per pick as the audio-KNN
// anchor. Absent on a plain tempo/key run.
interface RunState {
  bpm: number | null;
  key: string | null;
  remaining: number;
  showKey: string;
  waypoints?: number[][];
  step?: number;
}
let runState: RunState | null = null;
// The show the previous pick was for; null before the first pick of this
// process. A change between two picks is a show changeover.
let lastPickShowKey: string | null = null;

// What advanceRun hands back per pick: the tempo/key re-rank target (feature 4)
// and, when a sonic journey is active, the current waypoint vector for the
// picker's audio anchor. Either may be null independently. `endedForShow` is
// set on the pick where a show change ended a run that was still going, so the
// caller can say so in the booth.
interface RunStep {
  rankTarget: { bpm: number | null; key: string | null } | null;
  audioWaypoint: number[] | null;
  endedForShow?: boolean;
}

// The run's identity: the show on air at the pick, or one shared key for every
// autonomous block. Autonomous daypart/mood turnovers are soft shifts for the
// session too, and a run is shorter than any of them.
export function runShowKey(show: { id?: string | null } | null | undefined): string {
  return show?.id ? `show:${show.id}` : 'auto';
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

// Overlay a sonic journey on a freshly-started run. The destination is the
// centroid of a few tracks the show on air could play (music/journey-
// destination.ts), drawn from the daypart's energy bucket first so the run
// drifts the same way the tempo/key target nudges; with no show on air, the
// daypart energy bucket itself. No-op when the current track or the
// destination has no audio coverage, or the show cannot be placed in the
// library. `totalSteps` is how many picks the run influences.
async function maybeAttachJourney(rs: RunState, current: any, totalSteps: number, show: JourneyShow | null): Promise<void> {
  const startId = current?.id;
  if (!startId) return;
  try {
    const destEnergy = energyForDaypart().speed >= 1 ? 'high' : 'low';
    const bucket = await journeyDestinationIds(show, destEnergy);
    if (!bucket) return;
    // Draw ids the audio index actually covers, rather than slicing blind and
    // letting audioCentroid average around the gaps. The blocklist check moved
    // here from the bucket read, and only runs on ids that would be kept.
    const destIds: string[] = [];
    for (let i = 0; i < bucket.length && i < JOURNEY_DEST_PROBE_LIMIT; i++) {
      if (destIds.length >= JOURNEY_DEST_SAMPLE) break;
      if (library.hasAudioVector(bucket[i]) && !library.isBlockedId(bucket[i])) destIds.push(bucket[i]);
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
// `show` is the show on air when THIS pick plays (resolved at the pick's
// look-ahead clock), null for an autonomous block.
const NO_RUN: RunStep = { rankTarget: null, audioWaypoint: null };

export async function advanceRun(
  djMode: boolean,
  current: any,
  { show = null }: { show?: JourneyShow | null } = {},
): Promise<RunStep> {
  const showKey = runShowKey(show);
  const showChanged = lastPickShowKey !== null && lastPickShowKey !== showKey;
  lastPickShowKey = showKey;
  if (!djMode) { runState = null; return NO_RUN; }
  // A show change ends the run, and no new one starts on that pick: the first
  // pick of a show is chosen for that show, not as the next step of an arc
  // anchored on the outgoing host's last track. The next pick may start one.
  if (showChanged || (runState && runState.showKey !== showKey)) {
    const ended = !!(runState && runState.remaining > 0);
    runState = null;
    return ended ? { ...NO_RUN, endedForShow: true } : NO_RUN;
  }
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
  const started: RunState = { bpm: target.bpm, key: target.key, remaining: extra, showKey };
  runState = started;
  // This pick plus the `extra` that follow → extra + 1 waypoints.
  await maybeAttachJourney(started, current, extra + 1, show);
  return { rankTarget: target, audioWaypoint: takeWaypoint(started) };
}

// A pick that took no run step (the in-order walk, which replaces selection
// outright) is still a pick FOR a show. Record it, and end a run that belongs
// to another show, so the change it crossed is not missed: an autonomous run
// left going when an in-order show began would otherwise resume on the first
// pick after that show, since the walk never calls advanceRun.
export function notePickShow(show: { id?: string | null } | null | undefined): void {
  const showKey = runShowKey(show);
  if (runState && runState.showKey !== showKey) runState = null;
  lastPickShowKey = showKey;
}

export function runActive(): boolean {
  return !!(runState && runState.remaining > 0);
}

