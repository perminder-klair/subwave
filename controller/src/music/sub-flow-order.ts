// Work from the full, unfiltered album: removing a blocked or archive track
// before comparing positions could make its neighbours look adjacent.
type AlbumSong = { id?: unknown; albumId?: unknown; track?: unknown; discNumber?: unknown };
type Album = { id?: unknown; songCount?: unknown; song?: unknown };

export function orderedAlbumSongs(albumId: string, album: Album): AlbumSong[] {
  if (album.id !== albumId || !Array.isArray(album.song) || !Number.isInteger(album.songCount)
      || album.songCount !== album.song.length || album.song.length === 0) {
    throw new Error('The complete album track list is unavailable');
  }
  const songs = album.song as AlbumSong[];
  const hasMultipleDiscs = songs.some(song => typeof song?.discNumber === 'number' && song.discNumber > 1);
  const positions = songs.map(song => {
    const disc = song?.discNumber == null || song.discNumber === 0 ? 1 : song.discNumber;
    if (typeof song?.id !== 'string' || !song.id || (song.albumId != null && song.albumId !== albumId)
        || typeof song.track !== 'number' || !Number.isInteger(song.track) || song.track < 1
        || typeof disc !== 'number' || !Number.isInteger(disc) || disc < 1
        || (hasMultipleDiscs && (song.discNumber == null || song.discNumber === 0))) {
      throw new Error('The album has missing or ambiguous track numbering');
    }
    return { song, disc, track: song.track };
  }).sort((a, b) => a.disc - b.disc || a.track - b.track);
  const ids = new Set<string>();
  let previous: typeof positions[number] | undefined;
  for (const entry of positions) {
    const id = entry.song.id as string;
    if (ids.has(id) || (previous && entry.disc === previous.disc && entry.track === previous.track)) {
      throw new Error('The album has missing or ambiguous track numbering');
    }
    ids.add(id);
    previous = entry;
  }
  return positions.map(entry => entry.song);
}

// Box sets can omit non-audio discs; gaps only disqualify joins across them.
export function albumNeighbours(left: AlbumSong, right: AlbumSong): boolean {
  const leftDisc = Number(left.discNumber) || 1;
  const rightDisc = Number(right.discNumber) || 1;
  return rightDisc === leftDisc ? right.track === Number(left.track) + 1
    : rightDisc === leftDisc + 1 && (right.track === 1 || right.track === Number(left.track) + 1);
}

export function assertAdjacent(ids: string[], ordered: AlbumSong[]) {
  const first = ordered.findIndex(song => song.id === ids[0]);
  if (first < 0 || ids.some((id, index) => ordered[first + index]?.id !== id
    || (index > 0 && !albumNeighbours(ordered[first + index - 1]!, ordered[first + index]!)))) {
    throw new Error('Flow tracks must be consecutive tracks from the same album, in album order');
  }
}
