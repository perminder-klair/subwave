// Song contract shared by all backends.
export interface Song {
  id: string;           // 'plex:{ratingKey}' or bare Navidrome base32
  title: string;
  artist: string;
  album: string;
  year?: number;
  genre?: string;
  duration?: number;    // seconds
  path?: string;        // local path, used by isStationArchive guard
  // controller-augmented (not from source API):
  crossSec?: number;    // adaptive crossfade seconds (DJ mode)
  gainDb?: number;      // loudness normalisation in dB
}

export interface MusicSource {
  ping(): Promise<{ ok: boolean; reason?: string }>;
  isStationArchive(song: Song): boolean;
  search(query: string, opts?: { songCount?: number; songOffset?: number }): Promise<Song[]>;
  getRandomSongs(opts?: { size?: number; genre?: string; fromYear?: number; toYear?: number }): Promise<Song[]>;
  getSongsByGenre(genre: string, opts?: { count?: number }): Promise<Song[]>;
  getGenres(): Promise<{ value: string; songCount: number; albumCount: number }[]>;
  resolveGenreName(name: string): Promise<string | null>;
  resolveArtist(name: string, opts?: { artistCount?: number }): Promise<any | null>;
  getSimilarSongs(id: string, opts?: { count?: number }): Promise<Song[]>;
  supportsSonicSimilarity(): Promise<boolean>;
  getSonicSimilarTracks(id: string, opts?: { count?: number }): Promise<Song[]>;
  getStarred(): Promise<Song[]>;
  getRecentlyAddedAlbums(opts?: { size?: number }): Promise<any[]>;
  getFrequentAlbums(opts?: { size?: number }): Promise<any[]>;
  getArtistInfo(id: string, opts?: { count?: number }): Promise<any | null>;
  getTopSongs(artistName: string, opts?: { count?: number }): Promise<Song[]>;
  getRecentSongsByArtist(artistName: string, opts?: { albums?: number; count?: number }): Promise<Song[]>;
  getAlbum(id: string): Promise<Song[]>;
  getSong(id: string): Promise<Song | null>;
  getArtist(id: string): Promise<any | null>;
  searchArtists(query: string, opts?: { artistCount?: number }): Promise<any[]>;
  getArtistLastfmTags(id: string, opts?: { count?: number }): Promise<string[]>;
  getLyrics(songId: string): Promise<string>;
  iterateAllSongs(): AsyncGenerator<Song>;
  getPlaylists(): Promise<any[]>;
  getPlaylist(id: string): Promise<Song[]>;
  getCoverArtUrl(id: string, size?: number): string;
  getStreamUrl(songId: string): string;
  getRawStreamUrl(songId: string): string;
  getLocalPath(song: Song): string | null;
  getPlayableUri(song: Song): string;
  getAnnotatedUri(song: Song, opts?: { maxDurationSec?: number | null }): string;
}
