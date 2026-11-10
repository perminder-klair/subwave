// Derive feel from audioMoods, not metadata moods (#1443). Unanalysed tracks add no hint.
// Avoid BPM until octave errors on slow material are resolved (#1417).

import * as library from '../../../music/library.js';
import { HIGH_ENERGY_MOODS, LOW_ENERGY_MOODS } from '../../../music/audio-calibration.js';

// Stored zero-shot audio moods for a track, from the track object or a library
// lookup. [] when un-analysed or un-scored.
function audioMoodsFor(track: any): string[] {
  const own = track?.audioMoods;
  if (Array.isArray(own)) return own;
  const rec = track?.id ? library.get(track.id) : null;
  return Array.isArray(rec?.audioMoods) ? rec.audioMoods : [];
}

/**
 * One-word feel for a track — 'high-energy' | 'low-key' | null.
 *
 * Counts stored audio moods against the same arousal split the calibration
 * layer uses, so a renamed or deleted mood degrades to null rather than
 * flipping the answer (moods are operator-editable). A tie is null: two ends
 * pulling equally is not a feel, and silence is always a safe output here.
 */
export function trackFeel(track: any): 'high-energy' | 'low-key' | null {
  const moods = audioMoodsFor(track).map((m) => String(m).toLowerCase());
  if (!moods.length) return null;
  const high = moods.filter((m) => (HIGH_ENERGY_MOODS as readonly string[]).includes(m)).length;
  const low = moods.filter((m) => (LOW_ENERGY_MOODS as readonly string[]).includes(m)).length;
  if (high > low) return 'high-energy';
  if (low > high) return 'low-key';
  return null;
}

/**
 * The feel as a prompt suffix — ' — high-energy' or '' when unknown.
 *
 * Returned pre-joined so a call site can append it to an existing "Now
 * playing:" line without a conditional, and an un-analysed track produces a
 * byte-identical prompt to before.
 */
export function trackFeelSuffix(track: any): string {
  const feel = trackFeel(track);
  return feel ? ` — ${feel}` : '';
}
