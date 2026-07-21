// Station-archive guard.
//
// SUB/WAVE's own hourly mixdowns are written by radio.liq to
// `/var/sub-wave/archive/YYYY-MM-DD/HH-00.mp3`. If a music source's library
// overlaps that directory (a co-located Navidrome scanning the state dir, or a
// local-folder source pointed at an overlapping path), those MP3s get indexed as
// untagged songs whose filename ("02-00.mp3") becomes the title — they then leak
// into the picker (the DJ reads "02:00" as the time), the tagger, and the library
// UI (issue #273). Every selection/enumeration path funnels through the
// song-returning source methods, so filtering here keeps station recordings out
// of all of them. This predicate is source-agnostic (it inspects only
// path/title/artist/album), so it lives beside the source contract rather than
// inside any one source.

export function isStationArchive(song: any): boolean {
  if (!song) return false;
  const path = String(song.path ?? '');
  // Primary, tight signal: the archive path pattern radio.liq writes.
  if (/(^|\/)archive\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.mp3$/i.test(path)) return true;
  // Fallback when the source omits `path`: an HH-00 title with no real artist/album.
  const title = String(song.title ?? '').trim();
  const blank = (s: any) => {
    const v = String(s ?? '').trim().toLowerCase();
    return v === '' || v.startsWith('[unknown') || v === 'unknown artist' || v === 'unknown album';
  };
  return /^\d{2}-00$/.test(title) && blank(song.artist) && blank(song.album);
}
