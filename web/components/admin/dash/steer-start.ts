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
    const next = inputs.startNow ? ' to play next, in place of the DJ\'s queued picks' : '';
    if (state === 'valid' || state === 'resized') return `Start queues this track${next}. No model call is needed for it, and no steer is stored.`;
    if (state === 'stale') return `This track is out of date; Start works out a new one with one model call and queues it${next}.`;
    return `Start works out one track with one model call and queues it${next}. No steer is stored.`;
  }
  if (state === 'valid') {
    const { fit, picks } = preview!;
    if (fit >= picks.length) {
      return picks.length === 1
        ? 'Start plays this track first. No model call is needed for it; picking continues after.'
        : `Start plays these ${picks.length} tracks first. No model call is needed for them; picking continues after.`;
    }
    return `Start plays the first ${fit} of these, the ones that start before the steer ends. No model call is needed for them; picking continues after.`;
  }
  if (state === 'resized') {
    return 'Start plays as many of these as start before the steer ends at this length, with no model call. Preview again to see how many.';
  }
  if (state === 'stale') return 'These tracks are out of date; Start will work out a new list.';
  return `Start works out up to ${STEER_OPENING_TRACKS} opening tracks with one model call and plays the ones that start before the steer ends; picking continues after.`;
}
