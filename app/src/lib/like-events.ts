// A like made away from the heart: "like this song" from Siri
// (src/intents/on-air.ts). useTrackLike listens, so the heart and the Live
// Activity it drives fill now instead of on the next song's status fetch.

export interface ExternalLike {
  songId: string;
  /** Likes for the song, all airings, when the station said. */
  count?: number;
}

const listeners = new Set<(like: ExternalLike) => void>();

export function onExternalLike(fn: (like: ExternalLike) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function announceLike(like: ExternalLike): void {
  listeners.forEach((fn) => {
    try {
      fn(like);
    } catch {
      /* a broken subscriber must not fail the like */
    }
  });
}
