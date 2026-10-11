// Share gain resolution between real-track liq_amplify stamps and stem-render levels.
// ReplayGain describes the whole file; analyzer LUFS describes its leading window. No usable
// loudness means unity gain. #1240.

import * as settings from '../settings.js';
import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as mix from './mix.js';

export interface LoudnessTrack {
  id?: string | null;
  loudnessLufs?: number | null;
  peakDb?: number | null;
  replayGain?: { trackGain?: number | null; trackPeak?: number | null } | null;
  [k: string]: unknown;
}

// The dB offset this track plays at. Caches the ReplayGain answer onto the track
// object so a second call for the same object costs no extra Subsonic round-trip.
// `onWarn` surfaces an unreachable Navidrome; the lookup is best-effort and falls
// through to the measured value.
export async function resolveGainDb(
  track: LoudnessTrack | null | undefined,
  onWarn?: (msg: string) => void,
): Promise<number | null> {
  if (!track) return null;
  const loud = settings.get().loudness;
  const source = loud?.source ?? 'replaygain-then-measured';
  let lufs: number | null | undefined = null;
  let peakDb: number | null | undefined = null;
  if (source !== 'measured') {
    let rg = mix.loudnessFromReplayGain(track.replayGain);
    if (!rg && track.replayGain === undefined && track.id) {
      try {
        const song = await subsonic.getSong(track.id);
        track.replayGain = song?.replayGain ?? null; // cache the answer either way
        rg = mix.loudnessFromReplayGain(song?.replayGain);
      } catch (err) {
        // Best-effort — an unreachable Navidrome falls through to measured.
        onWarn?.(`replayGain lookup failed for ${track.id}: ${(err as Error).message}`);
      }
    }
    if (rg) {
      lufs = rg.lufs;
      peakDb = rg.peakDb;
      // A tag with a gain but no trackPeak: borrow the measured peak for the
      // headroom check rather than hold the boost at 0 (a boost needs a known
      // peak). It covers only the analysis window, so it can under-read the
      // file's real peak; the bus limiter stays the backstop for that, as it
      // already is for a measured track. A source pinned to 'replaygain' keeps
      // away from measurements entirely.
      if (peakDb == null && source !== 'replaygain') peakDb = measuredPeak(track);
    }
  }
  if (lufs == null && source !== 'replaygain') {
    lufs = track.loudnessLufs;
    peakDb = track.peakDb;
    if ((lufs == null || peakDb == null) && track.id) {
      const rec = library.get(track.id);
      if (lufs == null) lufs = rec?.loudnessLufs ?? null;
      if (peakDb == null) peakDb = rec?.peakDb ?? null;
    }
  }
  const gain = mix.gainForLoudness(lufs, {
    peakDb,
    targetLufs: loud?.targetLufs,
    maxBoostDb: loud?.maxBoostDb,
  });
  if (gain === 0 && typeof lufs === 'number' && Number.isFinite(lufs)) {
    const target =
      typeof loud?.targetLufs === 'number' && Number.isFinite(loud.targetLufs)
        ? loud.targetLufs
        : mix.LOUDNESS_TARGET_LUFS;
    const maxBoost =
      typeof loud?.maxBoostDb === 'number' && Number.isFinite(loud.maxBoostDb) && loud.maxBoostDb >= 0
        ? loud.maxBoostDb
        : mix.LOUDNESS_MAX_BOOST_DB;
    // A cut-only station (maxBoostDb 0) held nothing back.
    if (maxBoost > 0 && mix.boostNeedsPeak(target - lufs, peakDb)) {
      noteBoostHeld(track, Math.min(target - lufs, maxBoost), onWarn);
    }
  }
  return gain;
}

function measuredPeak(track: LoudnessTrack): number | null {
  if (typeof track.peakDb === 'number' && Number.isFinite(track.peakDb)) return track.peakDb;
  if (!track.id) return null;
  const rec = library.get(track.id);
  return typeof rec?.peakDb === 'number' && Number.isFinite(rec.peakDb) ? rec.peakDb : null;
}

// Once per track per process: the drain and a stem render resolve the same
// track, and a quiet track with no peak would otherwise log on every airing.
const heldNoted = new Set<string>();
const HELD_NOTED_MAX = 5000;

function noteBoostHeld(track: LoudnessTrack, wantedDb: number, onWarn?: (msg: string) => void): void {
  const key = track.id ?? '';
  if (!onWarn || !key || heldNoted.has(key)) return;
  if (heldNoted.size >= HELD_NOTED_MAX) heldNoted.clear();
  heldNoted.add(key);
  onWarn(
    `loudness: no peak known for ${key}, boost held at 0 dB (wanted +${Math.round(wantedDb * 10) / 10} dB); ` +
      're-analyse it to measure one',
  );
}

// Test seam: forget which tracks were already reported.
export function _resetBoostHeldNotesForTests(): void {
  heldNoted.clear();
}
