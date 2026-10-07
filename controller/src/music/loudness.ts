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
  return mix.gainForLoudness(lufs, {
    peakDb,
    targetLufs: loud?.targetLufs,
    maxBoostDb: loud?.maxBoostDb,
  });
}
