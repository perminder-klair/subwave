// The single answer to "how many dB does this track get on air" (#1240). Two
// consumers that must agree: the queue drain stamps it as `liq_amplify`, and the
// stem-blend render bakes the same figure into the clip (which carries no
// liq_amplify of its own — see subsonic.getClipUri).
//
// Order is the operator's `settings.loudness.source`: embedded ReplayGain
// (whole-file R128) first by default, else the analyzer's measured LUFS (leading
// window only, so the two are not interchangeable). Null loudness from every
// allowed source → null gain → unity.

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
