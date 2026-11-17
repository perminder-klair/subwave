// An overlay gets one offer at the head of a song. Unsafe offers are spent,
// never delayed into the middle of the song. No I/O or scheduling in this policy.
import type { JinglePlacement } from '../schemas/settings.js';

// Whether automatic overlay IDs are switched on at all.
export function overlayEnabled(placement: JinglePlacement, ratio: number): boolean {
  return placement !== 'between' && ratio > 0;
}

// In `both` the overlay rides the between-songs rotate's own count, so the two
// placements can never come due on the same song: the rotate is due once
// `ratio` songs have started since its last draw, and the overlay is offered
// once on the way there, about halfway. Ratio 1 makes every song the rotate's,
// which leaves no song for an overlay.
export function bothOverlayCount(ratio: number): number | null {
  if (!(ratio >= 2)) return null;
  return Math.min(ratio - 1, Math.floor(ratio / 2) + 1);
}

// The one due check. `over` keeps its own N-song count; `both` reads the
// rotate's count (above), so the overlay's own count is not consulted there.
export function overlayDue(p: {
  placement: JinglePlacement;
  ratio: number;
  tracksSinceOverlay: number;
  tracksSinceJingle: number;
}): boolean {
  if (!overlayEnabled(p.placement, p.ratio)) return false;
  if (p.placement === 'over') return p.tracksSinceOverlay >= p.ratio;
  return p.tracksSinceJingle === bothOverlayCount(p.ratio);
}

// The opening window: closed until the longest crossfade known to govern the
// song's opening has cleared, then open for headWindowMs, then closed for the
// rest of the song.
export function overlayOpening(p: { elapsedMs: number; crossfadeMs: number; headWindowMs: number }): 'early' | 'open' | 'closed' {
  if (p.elapsedMs < p.crossfadeMs) return 'early';
  return p.elapsedMs > p.crossfadeMs + p.headWindowMs ? 'closed' : 'open';
}

export interface OverlayOffer {
  due: boolean;
  elapsedMs: number;
  crossfadeMs: number;
  headWindowMs: number;
  trackVoice: boolean;
  voiceBusy: boolean;
  pendingTalk: boolean;
  pendingJingle: boolean;
}

export function overlayOffer(p: OverlayOffer): 'wait' | 'skip' | 'draw' {
  if (!p.due) return 'skip';
  if (p.trackVoice || p.voiceBusy || p.pendingTalk || p.pendingJingle) return 'skip';
  const opening = overlayOpening(p);
  return opening === 'early' ? 'wait' : opening === 'open' ? 'draw' : 'skip';
}

// Unlike a paid-for scheduled segment, an optional ID can always be skipped.
// Require a known playable span and a measured clip; never use the long-clip
// exception in segmentFitsRunway to talk past a measured singer's entry.
export function overlayFits(p: {
  elapsedMs: number;
  windowMs: number;
  remainingMs: number | null;
  exitCrossfadeMs: number;
  runwayMs: number | null;
}): boolean {
  if (!(p.windowMs > 0) || !Number.isFinite(p.windowMs) || p.remainingMs == null || !Number.isFinite(p.remainingMs)) return false;
  if (p.windowMs + p.exitCrossfadeMs >= p.remainingMs) return false;
  return p.runwayMs == null || p.elapsedMs + p.windowMs <= p.runwayMs;
}

// An old/unreachable mixer cannot prove safety or that its rotate is disabled.
// A new controller therefore fails silent until the broadcast image/restart catches up.
export function overlayMixerStatus(raw: string): { remainingMs: number; crossfadeMs: number } | null {
  try {
    const s = JSON.parse(raw);
    if (s.safe !== true || s.mixerRatio !== 0 || !Number.isFinite(s.remainingSeconds)
      || s.remainingSeconds <= 0 || !Number.isFinite(s.crossfadeSeconds) || s.crossfadeSeconds < 0) return null;
    return { remainingMs: s.remainingSeconds * 1000, crossfadeMs: s.crossfadeSeconds * 1000 };
  } catch {
    return null;
  }
}
