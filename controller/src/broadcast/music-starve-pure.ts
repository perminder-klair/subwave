// The music-chain starve signal (#1300 bug 7) — pure decision logic, split from
// the reader so it can be unit-pinned.
//
// The jingle rotate skips unavailable sources, so a starved music chain serves
// stingers forever and the emergency fallback below it can't see that (`radio`
// IS available). radio.liq samples the pre-rotate chain itself and reports the
// verdict in music-starved.json.
//
// Every ambiguous input resolves toward NOT starved: a false "your station is
// broken" banner that never clears is worse than a missed one.

/** How stale the heartbeat may get before the marker stops counting as live. */
export const STARVE_MARKER_STALE_MS = 60_000;

export interface StarveState {
  starved: boolean;
  /** Epoch ms the starve began, null when unknown or not starved. */
  since: number | null;
}

const NOT_STARVED: StarveState = { starved: false, since: null };

/** Marker timestamps are liquidsoap `time()` — unix SECONDS. This is the one
 *  place that conversion happens. Returns null for anything unusable. */
function toMs(raw: unknown): number | null {
  const ms = Number(raw) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Decide whether the mixer is currently reporting a starved music chain.
 * `now` is epoch ms; `marker` is the parsed music-starved.json (or null).
 */
export function starveState(marker: unknown, now: number): StarveState {
  if (!marker || typeof marker !== 'object') return NOT_STARVED;
  const m = marker as { starved?: unknown; since?: unknown; at?: unknown };

  // Only a literal true. A truthy value is a malformed marker, not a starve.
  if (m.starved !== true) return NOT_STARVED;

  // Heartbeat is the liveness proof: the marker is never deleted, so a mixer
  // that died mid-outage would otherwise report a starve forever.
  const atMs = toMs(m.at);
  if (atMs === null) return NOT_STARVED;
  if (now - atMs > STARVE_MARKER_STALE_MS) return NOT_STARVED;

  // `since` is best-effort: a starve we can't date is still a starve.
  return { starved: true, since: toMs(m.since) };
}
