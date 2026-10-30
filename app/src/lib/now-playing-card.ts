// Which media-session refreshes re-send the whole card and which only
// re-anchor the song clock (#2143). On iOS every card (title, artist, album,
// artwork) downloads the artwork again (Android's RNTP patch skips an
// unchanged one), so it goes out only when one of those strings changes or a
// new RNTP track item was loaded.
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
}

/** Whether a refresh re-sends the whole card: none has gone out since
 *  tune-in, a new track item was loaded, or a string on the card changed. */
export function sendsCard(last: SentCard | null, next: SentCard): boolean {
  return (
    last === null ||
    last.item !== next.item ||
    last.title !== next.title ||
    last.artist !== next.artist ||
    last.album !== next.album ||
    last.artwork !== next.artwork
  );
}
