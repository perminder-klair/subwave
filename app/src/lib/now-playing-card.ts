// Which media-session refreshes re-send the whole card and which only
// re-anchor the song clock (#2143). On iOS every card (title, artist, album,
// artwork) downloads the artwork again (Android's RNTP patch skips an
// unchanged one), so it goes out only when one of those strings changes, a new
// RNTP track item was loaded, or that item first plays.
//
// A load (tune-in, every reconnect, a lock-screen Play) resets the native card
// to the item's own placeholder strings: iOS's AudioPlayer.load rewrites
// title, artist, album and artwork from the item, and on Android the
// media-item transition drops KotlinAudio's metadata override while
// MusicService.load forgets the last card. Both happen before RNTP emits
// PlaybackActiveTrackChanged, so a card sent on that event lands after the
// reset. A card that fails to send needs no retry: RNTP refuses one only
// while no item is loaded, and the load that follows brings the event.
//
// A cover download that fails says nothing: iOS's Metadata.update drops the
// error, with the item's card already gone out. A load comes just when the
// link is suspect, so the item's first `playing`, which proves the link, sends
// the card once more (#2162). That is one more card per reconnect or tune-in,
// and none for a stall or a flip. On iOS it cancels a download still running
// and starts it again, at most once per item, and the image on screen stays
// until the new one lands. On Android the RNTP patch drops a card that changes
// nothing, so this neither interrupts Coil nor retries it: a cover that failed
// there waits for the next song or load.
//
// Every other refresh (a play/pause flip, the app coming to the foreground,
// the 30s re-anchor) carries progress only, which the RNTP patch applies
// without touching the artwork. A status flip still needs one: on every
// player state change iOS rewrites elapsed and duration from the stream's own
// clock.

export interface SentCard {
  title: string;
  artist: string | undefined;
  album: string | undefined;
  artwork: string | undefined;
  /** The loaded track item the card went onto: a count of
   *  PlaybackActiveTrackChanged events. */
  item: number;
  /** That item has reached `playing`. A later stall doesn't undo it. */
  played: boolean;
}

/** Whether `item` has played by this refresh, `playing` being what the player
 *  says now. Only the first `playing` counts, so a stall can't re-send the
 *  card, and a load starts over. */
export function hasPlayed(last: SentCard | null, item: number, playing: boolean): boolean {
  return playing || (last !== null && last.item === item && last.played);
}

/** Whether a refresh re-sends the whole card: none has gone out since
 *  tune-in, a new track item was loaded, that item first played, or a string
 *  on the card changed. */
export function sendsCard(last: SentCard | null, next: SentCard): boolean {
  return (
    last === null ||
    last.item !== next.item ||
    last.played !== next.played ||
    last.title !== next.title ||
    last.artist !== next.artist ||
    last.album !== next.album ||
    last.artwork !== next.artwork
  );
}
