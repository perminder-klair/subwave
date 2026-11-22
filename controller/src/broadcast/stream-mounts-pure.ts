// Which listener buffer to advertise: the burst the running mounts were rendered with,
// read from the Icecast renderer's stream-mounts.json, else the saved setting. #2142.
//
// Icecast's <burst-size> is rendered when the broadcast pair starts, while
// stream.bufferSeconds saves at once, so between a save and the next mixer
// restart the setting describes mounts that are not running yet. Every listener
// surface adds the advertised figure to live-edge timestamps, and the web idle
// skip sheds against it, so it must be the rendered one. An absent, malformed or
// self-contradicting marker is unknown (an older broadcast image writes none),
// and the setting is the answer, as it was before the marker existed.

import { STREAM_BUFFER_SECONDS_BOUNDS } from '../schemas/settings.js';

/** The always-served floor, whose burst every listener surface is told. */
export const ADVERTISED_MOUNT = '/stream.mp3';

/** The shipped default, for a setting that is somehow absent; both callers fell
 *  back to it before the marker existed. */
const SETTING_FALLBACK_SECONDS = 22;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * The advertised mount's rendered burst, in seconds, from the parsed marker (or
 * null). Null when there is no usable marker.
 */
export function renderedBufferSeconds(marker: unknown): number | null {
  if (!marker || typeof marker !== 'object') return null;
  const mounts = (marker as { mounts?: unknown }).mounts;
  if (!mounts || typeof mounts !== 'object') return null;
  const mount = (mounts as Record<string, unknown>)[ADVERTISED_MOUNT];
  if (!mount || typeof mount !== 'object') return null;
  const { kbps, burstSeconds, burstBytes } = mount as Record<string, unknown>;

  if (!isCount(burstSeconds) || !isCount(kbps) || !isCount(burstBytes) || kbps === 0) return null;
  if (burstSeconds < STREAM_BUFFER_SECONDS_BOUNDS.min || burstSeconds > STREAM_BUFFER_SECONDS_BOUNDS.max) return null;
  // The renderer writes the bytes it put in <burst-size>. Seconds that disagree
  // with them come from a writer this reader does not understand.
  if (burstBytes !== burstSeconds * kbps * 125) return null;
  return burstSeconds;
}

/** Seconds a listener sits behind the live edge: the rendered burst when the
 *  marker is usable, else the saved setting. */
export function listenerBufferSeconds(rendered: number | null, setting: unknown): number {
  if (rendered !== null) return rendered;
  return typeof setting === 'number' && Number.isFinite(setting) ? setting : SETTING_FALLBACK_SECONDS;
}
