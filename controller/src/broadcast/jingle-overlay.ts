// An overlay gets one offer at the head of a song. Unsafe offers are spent,
// never delayed into the middle of the song. No I/O or scheduling in this policy.
import type { JinglePlacement } from '../schemas/settings.js';

export interface OverlayOffer {
  placement: JinglePlacement;
  ratio: number;
  tracksSinceOverlay: number;
  elapsedMs: number;
  crossfadeMs: number;
  headWindowMs: number;
  trackVoice: boolean;
  voiceBusy: boolean;
  pendingTalk: boolean;
  pendingJingle: boolean;
}

export function overlayOffer(p: OverlayOffer): 'wait' | 'skip' | 'draw' {
  if (p.placement === 'between' || !(p.ratio > 0) || p.tracksSinceOverlay < p.ratio) return 'skip';
  if (p.trackVoice || p.voiceBusy || p.pendingTalk || p.pendingJingle) return 'skip';
  if (p.elapsedMs < p.crossfadeMs) return 'wait';
  if (p.elapsedMs > p.crossfadeMs + p.headWindowMs) return 'skip';
  return 'draw';
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
