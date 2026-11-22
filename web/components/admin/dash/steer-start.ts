// What pressing Start on the Steer card will do, said before it is pressed.
// Every steer opens with a fixed list of tracks: either the one Preview already
// worked out for this playlist, direction and "start now" (which decides the
// track the list follows), or one Start works out itself. How many of them play
// follows the steer's length too, because only the ones that start before the
// steer ends are queued. Pure, so the wording is tested without rendering the
// card.
import { STEER_OPENING_TRACKS, STEER_PREVIEW_MS, steerPreviewKey, type SteerUntil } from '@/lib/schemas.generated';

/** The card's inputs that decide what Start does. */
export interface SteerStartInputs {
  playlistId?: string | null;
  prompt?: string;
  until?: SteerUntil;
  minutes?: number;
  startNow?: boolean;
}

export interface SteerPreview {
  /** The playlist, direction and "start now" it was worked out for (`steerPreviewKey`). */
  key: string;
  /** The length it was sized for (`previewSizeKey`). */
  size: string;
  at: number;
  picks: { id: string; title: string; artist: string }[];
  /** How many of `picks` start before the steer ends, as sized. */
  fit: number;
}

export const previewKeyOf = (v: SteerStartInputs): string =>
  steerPreviewKey(v.playlistId ?? null, v.prompt ?? '', v.until === 'once', v.startNow === true);

export const previewSizeKey = (v: SteerStartInputs): string =>
  `${v.until ?? 'fixed'}\n${v.until === 'fixed' ? v.minutes ?? '' : ''}`;

/**
 * `valid`: worked out and sized for exactly these inputs. `resized`: the same
 * tracks, remembered, but sized for another length. `stale`: worked out for
 * another playlist, direction or "start now", or forgotten by the controller.
 */
export type PreviewState = 'valid' | 'resized' | 'none' | 'stale';

export function previewState(preview: SteerPreview | null, inputs: SteerStartInputs, now: number): PreviewState {
  if (!preview) return 'none';
  if (preview.key !== previewKeyOf(inputs) || now - preview.at >= STEER_PREVIEW_MS) return 'stale';
  return preview.size === previewSizeKey(inputs) ? 'valid' : 'resized';
}

export function startSentence(preview: SteerPreview | null, inputs: SteerStartInputs, now: number): string {
  const state = previewState(preview, inputs, now);
  if (inputs.until === 'once') {
    // A single track stores no steer, but "start now" still drops the DJ's own
    // queued picks so it plays next.
    const next = inputs.startNow ? ' next' : '';
    if (state === 'valid' || state === 'resized') return `Queues this track${next}. No model call.`;
    if (state === 'stale') return `Out of date. Start picks a fresh track${next} (one model call).`;
    return `Picks one track${next} (one model call).`;
  }
  if (state === 'valid') {
    const { fit, picks } = preview!;
    if (fit >= picks.length) {
      return picks.length === 1 ? 'Opens with this track. No model call.' : `Opens with these ${picks.length}. No model call.`;
    }
    return `Opens with the first ${fit}; the rest would start after it ends. No model call.`;
  }
  if (state === 'resized') return 'Opens with as many of these as fit the new length. No model call.';
  if (state === 'stale') return 'Out of date. Start picks a fresh list.';
  return `Picks up to ${STEER_OPENING_TRACKS} opening tracks (one model call).`;
}
