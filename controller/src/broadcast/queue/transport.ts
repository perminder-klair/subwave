// The queue's playback TRANSPORT seam. In file mode a pick becomes a request URI
// in next.txt (queue.drainToLiquidsoap, the single writer). A music source whose
// capabilities say `hasLiveTransport` plays through a live mixer input instead —
// there is no URI to hand over — so the drain hands the QueueItem to whatever
// transport is registered here and stops.
//
// Deliberately a registry with no import of any source: the queue must not know
// Spotify exists (that is the whole point of the MusicSource seam), and the
// transport must be able to import the queue. music/sources/spotify/transport.ts
// registers itself at boot when spotify is the active source.

import type { QueueItem } from './types.js';

export interface PlaybackTransport {
  readonly id: string;
  // The drain has decided this item should be committed; the transport owns it
  // from here (start it at the seam, confirm it started, publish its metadata).
  handoff(item: QueueItem): Promise<void>;
  // Operator skip: end the current track now and start the next one.
  skip(): Promise<boolean>;
  // Operator-facing state for /state and the doctor.
  status(): Record<string, unknown>;
}

let live: PlaybackTransport | null = null;

export function setLiveTransport(t: PlaybackTransport | null): void {
  live = t;
}

export function liveTransport(): PlaybackTransport | null {
  return live;
}
