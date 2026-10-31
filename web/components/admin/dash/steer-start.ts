// What pressing Start on the Steer card will do, said before it is pressed.
// Every steer opens with a fixed list of tracks: either the one Preview already
// worked out for this playlist and direction, or one Start works out itself.
// Pure, so the wording is tested without rendering the card.

/** How long the controller remembers a preview (routes/steer.ts MEMO_MS). */
export const PREVIEW_VALID_MS = 5 * 60_000;

export interface SteerPreview {
  /** The playlist, direction and length it was worked out for. */
  key: string;
  at: number;
  picks: { id: string; title: string; artist: string }[];
}

// A single track and an opening list are worked out separately, as on the controller.
export const previewKey = (playlistId: string | null | undefined, prompt: string | undefined, once = false): string =>
  `${once ? 1 : 5}\n${playlistId ?? ''}\n${(prompt ?? '').replace(/\s+/g, ' ').trim()}`;

export type PreviewState = 'valid' | 'none' | 'stale';

export function previewState(preview: SteerPreview | null, key: string, now: number): PreviewState {
  if (!preview) return 'none';
  return preview.key === key && now - preview.at < PREVIEW_VALID_MS ? 'valid' : 'stale';
}

export function startSentence(preview: SteerPreview | null, key: string, now: number, once: boolean): string {
  const state = previewState(preview, key, now);
  if (state === 'valid') {
    const n = once ? 1 : preview!.picks.length;
    return n === 1
      ? 'Start queues this track. No model call is needed for it.'
      : `Start plays these ${n} tracks first. No model call is needed for them; picking continues after.`;
  }
  if (state === 'stale') return 'These tracks are out of date; Start will work out a new list.';
  return once
    ? 'Start works out one track with one model call and queues it. Nothing else changes.'
    : 'Start works out up to five opening tracks with one model call, shows them here and plays them; picking continues after.';
}
